// AI による初期設定・修正提案（Cloudflare Workflows）。docs/design.md §7
// AI が試したい操作はすべて VPS へのプローブジョブに変換し、結果を待ってから次のターンへ進む。
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { GoogleGenAI, type Content, type Part, type FunctionDeclaration } from "@google/genai";
import { parseConfig, identityScheme, hashScheme, schemeHash, DetailSchema, type DetailConfig, type SubscriptionConfig, type ProbeRequest } from "@ws/shared";
import { type Env, newId, nowIso, json } from "../env.js";
import { enqueueProbe } from "../jobs.js";
import { SYSTEM_PROMPT, TOOLS, DETAIL_SYSTEM_PROMPT, DETAIL_TOOLS } from "./prompt.js";

export interface SetupParams {
  sessionId: string;
  subscriptionId: string;
  kind: "setup" | "repair" | "detail";
  url: string;
  triggerRunId?: string;
}

interface Proposal {
  config: SubscriptionConfig;
  rationale: string;
  unverified: string[];
  feed_assessment?: string;
  origin: "ai_setup" | "ai_repair" | "ai_detail" | "heuristic";
}

const MAX_TURNS = 16;

type StepCfg = Parameters<WorkflowStep["do"]>[1];
/** step.do の型付きラッパー（戻り値は JSON シリアライズ可能であること） */
function sdo<T>(step: WorkflowStep, name: string, a: StepCfg | (() => Promise<T>), b?: () => Promise<T>): Promise<T> {
  const fn = (b ?? a) as () => Promise<T>;
  const wrapped = async () => JSON.parse(JSON.stringify((await fn()) ?? null));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (b ? step.do(name, a as any, wrapped as any) : step.do(name, wrapped as any)) as unknown as Promise<T>;
}

export async function addProgress(env: Env, sessionId: string, stepName: string, status: "running" | "done" | "error" | "info", detail?: string) {
  const row = await env.DB.prepare("SELECT progress_json FROM setup_sessions WHERE id = ?").bind(sessionId).first<{ progress_json: string }>();
  const arr = json<{ step: string; status: string; detail?: string; at: string }[]>(row?.progress_json, []);
  const existing = arr.findIndex((p) => p.step === stepName);
  const entry = { step: stepName, status, detail, at: nowIso() };
  if (existing >= 0 && status !== "info") arr[existing] = entry;
  else arr.push(entry);
  await env.DB.prepare("UPDATE setup_sessions SET progress_json = ?, updated_at = ? WHERE id = ?").bind(JSON.stringify(arr), nowIso(), sessionId).run();
}

async function loadProbe(env: Env, probeId: string): Promise<{ status: string; error: string | null; summary: unknown }> {
  const p = await env.DB.prepare("SELECT status, error, result_key FROM probes WHERE id = ?").bind(probeId).first<{ status: string; error: string | null; result_key: string | null }>();
  if (!p) return { status: "missing", error: "probe_missing", summary: null };
  let summary: unknown = null;
  if (p.result_key) {
    const o = await env.BLOBS.get(p.result_key);
    if (o) summary = await o.json();
  }
  return { status: p.status, error: p.error, summary };
}

function sameSite(a: string, b: string): boolean {
  try {
    const ha = new URL(a).hostname.replace(/^www\./, "");
    const hb = new URL(b).hostname.replace(/^www\./, "");
    return ha === hb || ha.endsWith("." + hb) || hb.endsWith("." + ha);
  } catch {
    return false;
  }
}

function truncateJson(v: unknown, max = 24000): string {
  const s = JSON.stringify(v);
  return s.length > max ? s.slice(0, max) + `…(truncated ${s.length - max} chars)` : s;
}

/** run_extraction の結果を AI 向けに要約 */
function summarizeExtraction(summary: unknown): unknown {
  const s = summary as Record<string, Record<string, unknown>>;
  const out: Record<string, unknown> = {};
  for (const [m, r] of Object.entries(s ?? {})) {
    if (!r || typeof r !== "object") continue;
    if ("error" in r) {
      out[m] = r;
      continue;
    }
    out[m] = {
      outcome: r.outcome,
      pages: (r.pages as Record<string, unknown>[] | undefined)?.map((p) => ({
        seq: p.seq,
        kind: p.kind,
        url: p.url,
        http_status: p.http_status,
        action_result: p.action_result,
        extract_status: p.extract_status,
        item_count: p.item_count,
        error: p.error,
        field_failures: p.field_failures,
      })),
      item_count: r.item_count,
      valid_items: r.valid_items,
      identity_missing: r.identity_missing,
      identity_unique: r.identity_unique,
      field_fill: r.field_fill,
      channel_title: (r.channel as { title?: { value?: string } } | null)?.title?.value,
      items_sample: (r.items as unknown[] | undefined)?.slice(0, 6),
    };
  }
  return out;
}

/** AI 未設定時・AI 失敗時の決定的な提案（RSS/Atom、または最大の繰り返し構造） */
function heuristicProposal(url: string, d: Record<string, unknown>, current?: SubscriptionConfig | null): Proposal {
  const feeds = (d.feeds as { ok: boolean; url: string; item_count: number; items_with_guid: number }[] | undefined) ?? [];
  const okFeed = feeds.find((f) => f.ok && f.item_count > 0);
  // 修正提案では現行の種類（feed/html）を勝手に変えない
  if ((d.is_feed || okFeed) && (!current || current.source.kind === "feed")) {
    const f = okFeed ?? feeds[0];
    const r = parseConfig({
      schema_version: 1,
      source: { url: f?.url ?? url, kind: "feed" },
      fetch: { method: "http" },
      feed: { format: "auto" },
      identity: { method: f && f.items_with_guid === f.item_count ? "source_id" : "link" },
    });
    if (r.ok)
      return {
        config: r.config,
        rationale: `RSS/Atom（${f?.url ?? url}）が見つかったためフィードを購読する（自動判定）。`,
        unverified: ["AI未使用の自動判定。HTML版との網羅性は比較していない"],
        feed_assessment: `${f?.url ?? url}: ${f?.item_count ?? "?"} items`,
        origin: "heuristic",
      };
  }
  type Rep = { container: string; item_selector: string; count: number };
  const so = d.static_outline as { repeats: Rep[] } | null;
  const bo = d.browser_outline as { repeats: Rep[] } | null;
  const staticTop = so?.repeats?.[0];
  const browserTop = bo?.repeats?.[0];
  const useHttp = !!staticTop && (!browserTop || staticTop.item_selector === browserTop.item_selector);
  const top = useHttp ? staticTop : browserTop;
  if (!top) throw new Error("繰り返し構造が見つからず、自動で設定案を作れませんでした");
  const r = parseConfig({
    schema_version: 1,
    source: { url, kind: "html" },
    fetch: { method: useHttp ? "http" : "browser" },
    extract: {
      items: {
        container: { css: top.container },
        select: { css: top.item_selector },
        fields: {
          title: { from: { css: "a" }, cardinality: "first", take: "text", transforms: ["collapse_whitespace"], required: true, fallback: [{ take: "text", transforms: ["collapse_whitespace"] }] },
          link: { from: { css: "a[href]" }, cardinality: "first", take: { attr: "href" }, transforms: [{ resolve_url: {} }], required: true },
          published_at: {
            from: { css: "time" },
            cardinality: "first",
            take: { attr: "datetime" },
            transforms: [{ parse_date: {} }],
            fallback: [{ from: { css: "time" }, cardinality: "first", take: "text", transforms: ["trim", { parse_date: {} }] }],
          },
        },
      },
    },
    // 修正提案では既存itemと照合できるよう識別方法を引き継ぐ
    identity: current?.identity ?? { method: "link" },
    wait: useHttp ? {} : { initial: { cond: { all: [{ exists: { css: top.container } }, { stable: { target: { css: top.container }, for_ms: 800 } }] }, timeout_ms: 15000 } },
  });
  if (!r.ok) throw new Error(r.errors.join("; "));
  return {
    config: r.config,
    rationale: `最大の繰り返し構造（${top.item_selector}, ${top.count}件）をitemとし、先頭リンクをタイトル・閲覧URLとした（自動判定）。`,
    unverified: ["AI未使用の自動判定。ページングは調査していない", "日付の抽出は time 要素がある場合のみ"],
    origin: "heuristic",
  };
}

interface DetailProposal {
  detail: DetailConfig;
  rationale: string;
  unverified: string[];
}

interface ToolLoopSpec<T> {
  /** ステップ名・保存キーの接頭辞（ワークフローの再実行で同じ名前になること） */
  prefix: string;
  system: string;
  tools: FunctionDeclaration[];
  submitName: string;
  startNote: string;
  intro: () => Promise<string>;
  submit: (input: Record<string, unknown>) => { value: T } | { error: string };
  tool: (name: string, input: Record<string, unknown>) => { req: ProbeRequest; summarize?: (s: unknown) => unknown } | { error: string };
}

function inspectReq(input: Record<string, unknown>, siteUrl: string): { req: ProbeRequest } | { error: string } {
  const url = String(input.url ?? "");
  if (!sameSite(url, siteUrl)) return { error: "登録URLと同じサイトのURLのみ調査できます" };
  return { req: { kind: "inspect", url, method: input.method === "browser" ? "browser" : "http", selector: input.selector as { css: string }, wait_ms: Number(input.wait_ms ?? 0) || undefined } };
}

export class SetupWorkflow extends WorkflowEntrypoint<Env, SetupParams> {
  async run(event: WorkflowEvent<SetupParams>, step: WorkflowStep) {
    const p = event.payload;
    const env = this.env;
    const sid = p.sessionId;
    try {
      let prop: Proposal;
      if (p.kind === "detail") {
        // 既存の購読設定に詳細ページの取得を追加する（一覧の抽出設定は変えない）
        if (!env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY が未設定のため、詳細ページの取得ルールを作れません");
        prop = await sdo(step, "current-config", async () => {
          const row = await env.DB.prepare("SELECT cv.config_json FROM subscriptions s JOIN config_versions cv ON cv.id = s.active_config_version_id WHERE s.id = ?").bind(p.subscriptionId).first<{ config_json: string }>();
          if (!row) throw new Error("有効な設定がありません");
          return { config: JSON.parse(row.config_json) as SubscriptionConfig, rationale: "現行の設定に、リンク先（詳細ページ）からの取得を追加する。", unverified: [], origin: "ai_detail" } satisfies Proposal;
        });
      } else {
        await sdo(step, "start", async () => addProgress(env, sid, "discover", "running", "URLをVPSで取得（HTTP / ブラウザ）"));

        // 1) 調査
        const discovery = (await this.probe(step, sid, "discover", { kind: "discover", url: p.url })) as Record<string, unknown>;
        await sdo(step, "discover-done", async () => {
          const feeds = (discovery?.feeds as { ok: boolean }[] | undefined)?.filter((f) => f.ok).length ?? 0;
          const http = discovery?.http as { status?: number } | undefined;
          const br = discovery?.browser as { status?: number } | undefined;
          await addProgress(env, sid, "discover", "done", `HTTP ${http?.status ?? "-"} / browser ${br?.status ?? "-"} / feed候補 ${feeds}`);
        });

        // 2) 提案（AI or 自動判定）
        let proposal: Proposal | null = null;
        if (env.GEMINI_API_KEY) {
          try {
            proposal = await this.aiLoop(step, p, discovery);
          } catch (e) {
            await sdo(step, "ai-failed", async () => addProgress(env, sid, "ai-error", "error", `AI提案に失敗したため自動判定に切り替えます: ${(e as Error).message}`));
          }
        } else {
          await sdo(step, "no-ai", async () => addProgress(env, sid, "propose", "info", "GEMINI_API_KEY 未設定のため自動判定で提案します"));
        }
        if (!proposal)
          proposal = await sdo(step, "heuristic", async () => {
            let current: SubscriptionConfig | null = null;
            if (p.kind === "repair") {
              const row = await env.DB.prepare("SELECT cv.config_json FROM subscriptions s JOIN config_versions cv ON cv.id = s.active_config_version_id WHERE s.id = ?").bind(p.subscriptionId).first<{ config_json: string }>();
              current = row ? (JSON.parse(row.config_json) as SubscriptionConfig) : null;
            }
            const prop = heuristicProposal(p.url, discovery, current);
            if (p.kind === "repair") prop.unverified.push("AI未使用のため、修正は最大の繰り返し構造からの自動推定です。内容を確認してください");
            return { ...prop, origin: p.kind === "repair" ? "ai_repair" : prop.origin };
          });
        // 修正提案：詳細ページの取得ルールは一覧の修正とは独立なので引き継ぐ
        if (p.kind === "repair" && !proposal.config.detail) {
          const cur = proposal;
          proposal = await sdo(step, "carry-detail", async () => {
            const row = await env.DB.prepare("SELECT json_extract(cv.config_json, '$.detail') AS detail FROM subscriptions s JOIN config_versions cv ON cv.id = s.active_config_version_id WHERE s.id = ?").bind(p.subscriptionId).first<{ detail: string | null }>();
            return row?.detail ? { ...cur, config: { ...cur.config, detail: JSON.parse(row.detail) as DetailConfig } } : cur;
          });
        }
        prop = proposal;
        const r = prop.rationale;
        await sdo(step, "propose-done", async () => addProgress(env, sid, "propose", "done", r.slice(0, 200)));
      }

      // 3) 検証：http と browser を比較し、採用方式で2回実行して安定性を確認
      await sdo(step, "validate-start", async () => addProgress(env, sid, "validate", "running", "設定案をVPSで実行して検証"));
      const listCfg: SubscriptionConfig = { ...prop.config, detail: null };
      const methods: ("http" | "browser")[] = listCfg.source.kind === "feed" ? ["http"] : listCfg.fetch.method === "browser" ? ["browser", "http"] : ["http", "browser"];
      const v1 = (await this.probe(step, sid, "validate-1", { kind: "extract", config: listCfg, max_pages: 3, methods })) as Record<string, ValResult>;
      const v2 = (await this.probe(step, sid, "validate-2", { kind: "extract", config: listCfg, max_pages: 3, methods: [listCfg.fetch.method] })) as Record<string, ValResult>;

      // 4) 詳細ページ：一覧に本文がなければ、リンク先から取るルールを AI が作る
      const main = v1[listCfg.fetch.method];
      const sample = main && !("error" in main) ? sampleDetailUrls(main, listCfg.source.url) : [];
      let detailCheck: DetailValidation | null = null;
      const wantDetail = p.kind === "detail" || (!prop.config.detail && !!env.GEMINI_API_KEY && !!main && !("error" in main) && lacksContent(main));
      if (wantDetail && sample.length > 0) {
        await sdo(step, "detail-start", async () => addProgress(env, sid, "detail", "running", `一覧に本文がないため、リンク先 ${sample.length} ページを比較して取得ルールを作成`));
        try {
          const dp = await this.detailAiLoop(step, p, listCfg, sample, (main as ValResult).items.slice(0, 5));
          prop = { ...prop, config: { ...prop.config, detail: dp.detail }, unverified: [...prop.unverified, ...dp.unverified], rationale: `${prop.rationale}\n\n詳細ページ: ${dp.rationale}` };
        } catch (e) {
          if (p.kind === "detail") throw e;
          const msg = (e as Error).message;
          await sdo(step, "detail-failed", async () => addProgress(env, sid, "detail", "error", `詳細ページの取得ルールは作れませんでした: ${msg}`));
          prop = { ...prop, unverified: [...prop.unverified, `詳細ページの取得ルールは作れなかった（${msg}）`] };
        }
      } else if (p.kind === "detail") throw new Error("リンク先（閲覧URL）のある item が見つかりません");
      // 詳細ページのルールを機械的に検証（AI が試したページを含め最大5ページ）
      if (prop.config.detail && sample.length > 0) {
        const cfg = prop.config;
        detailCheck = (await this.probe(step, sid, "detail-validate", { kind: "detail", config: cfg, urls: sample.slice(0, 5) })) as DetailValidation;
        const dc = detailCheck;
        await sdo(step, "detail-done", async () => addProgress(env, sid, "detail", "done", `詳細ページ ${dc.ok_pages}/${dc.page_count} 件で取得（${Object.entries(dc.field_fill).map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(" / ")}）`));
      }

      // 5) 報告・draft 作成
      const fp = prop;
      const result = await sdo(step, "finalize", async () => this.finalize(p, fp, v1, v2, detailCheck));
      await sdo(step, "done", async () => addProgress(env, sid, "validate", "done", result.headline));
    } catch (e) {
      await sdo(step, "fail", async () => {
        await addProgress(env, sid, "error", "error", (e as Error).message);
        await env.DB.prepare("UPDATE setup_sessions SET status = 'failed', error = ?, updated_at = ? WHERE id = ?").bind((e as Error).message, nowIso(), sid).run();
      });
    }
  }

  /** プローブを投入し、完了イベント（または DB 状態）を待って結果を返す */
  private async probe(step: WorkflowStep, sid: string, name: string, req: ProbeRequest): Promise<unknown> {
    const env = this.env;
    const probeId = await sdo(step, `${name}-enqueue`, async () => enqueueProbe(env, sid, req));
    for (let i = 0; i < 4; i++) {
      const st = await sdo(step, `${name}-check-${i}`, async () => (await loadProbe(env, probeId)).status);
      if (st === "ok" || st === "error") break;
      try {
        await step.waitForEvent(`${name}-wait-${i}`, { type: `probe-${probeId}`, timeout: "10 minutes" });
        break;
      } catch {
        /* タイムアウト：状態を再確認 */
      }
    }
    const res = await sdo(step, `${name}-load`, async () => {
      const r = await loadProbe(env, probeId);
      return { status: r.status, error: r.error, summary: r.summary as Record<string, unknown> | null };
    });
    if (res.status !== "ok") throw new Error(`probe ${req.kind} failed: ${res.error ?? res.status}`);
    return res.summary;
  }

  private async aiLoop(step: WorkflowStep, p: SetupParams, discovery: Record<string, unknown>): Promise<Proposal> {
    const env = this.env;
    return this.toolLoop<Proposal>(step, p, {
      prefix: "ai",
      system: SYSTEM_PROMPT,
      tools: TOOLS,
      submitName: "submit_config",
      startNote: "AIが取得方法と抽出ルールを調査中",
      intro: async () => {
        let intro = `購読したいURL: ${p.url}\n\n以下は VPS で取得した調査結果です（HTTP取得、ブラウザ実行後のDOMアウトライン、繰り返し構造候補、ページング候補、RSS/Atom候補）。\n<untrusted_page_data>\n${truncateJson(discovery, 60000)}\n</untrusted_page_data>`;
        if (p.kind === "repair") {
          const sub = await env.DB.prepare("SELECT active_config_version_id FROM subscriptions WHERE id = ?").bind(p.subscriptionId).first<{ active_config_version_id: string }>();
          const cv = sub && (await env.DB.prepare("SELECT config_json FROM config_versions WHERE id = ?").bind(sub.active_config_version_id).first<{ config_json: string }>());
          const run = p.triggerRunId ? await env.DB.prepare("SELECT end_reason, error_stage, error_detail FROM crawl_runs WHERE id = ?").bind(p.triggerRunId).first() : null;
          const pages = p.triggerRunId ? await env.DB.prepare("SELECT seq, http_status, extract_status, item_count, error, field_failures_json FROM crawl_pages WHERE run_id = ? ORDER BY seq").bind(p.triggerRunId).all() : null;
          intro =
            `これは稼働中の購読設定の「修正提案」です。現在の設定で抽出が失敗しています。現行設定をできるだけ保ちながら、壊れた部分（セレクタ・待機条件など）を直してください。識別方法（identity）は既存itemとの照合のため、可能な限り変えないでください。\n\n現行設定:\n${cv?.config_json}\n\n失敗した実行:\n${JSON.stringify(run)}\n${JSON.stringify(pages?.results)}\n\n` +
            intro;
        }
        return intro + "\n\nツールで検証しながら設定を作り、submit_config で提出してください。";
      },
      submit: (input) => {
        const parsed = parseConfig(input.config);
        if (!parsed.ok) return { error: "スキーマ検証エラー:\n" + parsed.errors.join("\n") };
        if (!sameSite(parsed.config.source.url, p.url)) return { error: "source.url は登録URLと同じサイトでなければなりません" };
        return {
          value: {
            config: parsed.config,
            rationale: String(input.rationale ?? ""),
            unverified: Array.isArray(input.unverified) ? (input.unverified as unknown[]).map(String) : [],
            feed_assessment: input.feed_assessment ? String(input.feed_assessment) : undefined,
            origin: p.kind === "repair" ? "ai_repair" : "ai_setup",
          },
        };
      },
      tool: (name, input) => {
        if (name === "inspect") return inspectReq(input, p.url);
        if (name === "run_extraction") {
          const parsed = parseConfig(input.config);
          if (!parsed.ok) return { error: "スキーマ検証エラー:\n" + parsed.errors.join("\n") };
          if (!sameSite(parsed.config.source.url, p.url)) return { error: "登録URLと同じサイトのURLのみ調査できます" };
          const methods = (Array.isArray(input.methods) ? input.methods : [parsed.config.fetch.method]).filter((m: unknown) => m === "http" || m === "browser") as ("http" | "browser")[];
          return {
            req: { kind: "extract", config: parsed.config, max_pages: Math.min(Math.max(Number(input.max_pages ?? 2), 1), 3), methods: methods.length ? methods : [parsed.config.fetch.method] },
            summarize: summarizeExtraction,
          };
        }
        return { error: `unknown tool ${name}` };
      },
    });
  }

  /** 詳細ページ（item のリンク先）の取得ルールを AI が複数ページを比較して作る */
  private async detailAiLoop(step: WorkflowStep, p: SetupParams, config: SubscriptionConfig, sampleUrls: string[], listSample: unknown[]): Promise<DetailProposal> {
    const outline = await this.probe(step, p.sessionId, "detail-outline", { kind: "outline", urls: sampleUrls.slice(0, 3), method: "http" });
    return this.toolLoop<DetailProposal>(step, p, {
      prefix: "detail",
      system: DETAIL_SYSTEM_PROMPT,
      tools: DETAIL_TOOLS,
      submitName: "submit_detail",
      startNote: "AIがリンク先（詳細ページ）の取得ルールを調査中",
      intro: async () =>
        `購読先: ${config.source.url}\n一覧から取れている item の例（本文が不足しています）:\n<untrusted_page_data>\n${truncateJson(listSample, 8000)}\n</untrusted_page_data>\n\n` +
        `詳細ページのサンプルURL（run_detail_extraction で urls を省略するとこれらで実行します）:\n${sampleUrls.join("\n")}\n\n` +
        `以下は先頭 ${Math.min(3, sampleUrls.length)} ページを http（JS非実行）で取得したアウトラインとメタ情報です。\n<untrusted_page_data>\n${truncateJson(outline, 50000)}\n</untrusted_page_data>\n\n` +
        `複数ページを比較して共通の構造から詳細取得ルールを作り、run_detail_extraction で検証してから submit_detail で提出してください。`,
      submit: (input) => {
        const r = DetailSchema.safeParse(input.detail);
        if (!r.success) return { error: "スキーマ検証エラー:\n" + r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("\n") };
        if (Object.keys(r.data.fields).length === 0) return { error: "fields が空です" };
        return { value: { detail: r.data, rationale: String(input.rationale ?? ""), unverified: Array.isArray(input.unverified) ? (input.unverified as unknown[]).map(String) : [] } };
      },
      tool: (name, input) => {
        if (name === "inspect") return inspectReq(input, config.source.url);
        if (name === "run_detail_extraction") {
          const r = DetailSchema.safeParse(input.detail);
          if (!r.success) return { error: "スキーマ検証エラー:\n" + r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("\n") };
          const urls = (Array.isArray(input.urls) && input.urls.length ? (input.urls as unknown[]).map(String) : sampleUrls).filter((u) => sameSite(u, config.source.url)).slice(0, 6);
          if (!urls.length) return { error: "購読先と同じサイトのURLのみ調査できます" };
          return { req: { kind: "detail", config: { ...config, detail: r.data }, urls } };
        }
        return { error: `unknown tool ${name}` };
      },
    });
  }

  /** ツール使用ループ。AI のツール呼び出しは VPS プローブに変換して結果を返す */
  private async toolLoop<T>(step: WorkflowStep, p: SetupParams, spec: ToolLoopSpec<T>): Promise<T> {
    const env = this.env;
    const pre = spec.prefix;
    const key = (n: string) => `sessions/${p.sessionId}/${pre === "ai" ? "messages" : `${pre}-messages`}-${n}.json`;
    await sdo(step, `${pre}-init`, async () => {
      await addProgress(env, p.sessionId, pre === "ai" ? "propose" : `${pre}-propose`, "running", spec.startNote);
      const msgs: Content[] = [{ role: "user", parts: [{ text: await spec.intro() }] }];
      await env.BLOBS.put(key("0"), JSON.stringify(msgs));
    });

    const client = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY, httpOptions: env.GEMINI_BASE_URL ? { baseUrl: env.GEMINI_BASE_URL } : undefined });
    let nudges = 0;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const res = await sdo(step, `${pre}-turn-${turn}`, { retries: { limit: 2, delay: "15 seconds", backoff: "exponential" }, timeout: "10 minutes" }, async () => {
        const msgs = (await (await env.BLOBS.get(key(String(turn))))!.json()) as Content[];
        const r = await client.models.generateContent({
          model: env.GEMINI_MODEL || "gemini-3.5-flash-lite",
          contents: msgs,
          config: {
            systemInstruction: spec.system,
            tools: [{ functionDeclarations: spec.tools }],
            maxOutputTokens: 32000,
          },
        });
        const cand = r.candidates?.[0];
        const blocked = r.promptFeedback?.blockReason ?? (cand && ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII"].includes(String(cand.finishReason)) ? cand.finishReason : null);
        if (blocked) return { blocked: String(blocked), uses: [], text: "" };
        // モデルの応答はそのまま履歴に残す（thought signature を保持するため）
        const content: Content = cand?.content ?? { role: "model", parts: [] };
        msgs.push({ role: "model", parts: content.parts ?? [] });
        await env.BLOBS.put(key(`${turn}-a`), JSON.stringify(msgs));
        const parts: Part[] = content.parts ?? [];
        const uses = parts
          .filter((pt) => pt.functionCall)
          .map((pt, i) => ({ id: pt.functionCall!.id ?? `call-${turn}-${i}`, name: pt.functionCall!.name ?? "", input: (pt.functionCall!.args ?? {}) as Record<string, unknown> }));
        const text = parts
          .filter((pt) => pt.text && !pt.thought)
          .map((pt) => pt.text)
          .join("\n");
        return { blocked: null as string | null, uses, text: text.slice(0, 500) };
      });
      if (res.blocked) throw new Error(`AIが要求を処理できませんでした（${res.blocked}）`);
      if (res.text) await sdo(step, `${pre}-note-${turn}`, async () => addProgress(env, p.sessionId, `${pre}-${turn}`, "info", res.text.slice(0, 300)));

      const results: { tool_use_id: string; name: string; content: string; is_error?: boolean }[] = [];
      let accepted: T | null = null;
      if (res.uses.length === 0) {
        if (++nudges > 2) throw new Error("AIが結果を提出しませんでした");
      }
      for (let j = 0; j < res.uses.length; j++) {
        const u = res.uses[j];
        const tag = pre === "ai" ? `t${turn}-${j}` : `${pre}-t${turn}-${j}`;
        if (u.name === spec.submitName) {
          const r = spec.submit(u.input);
          if ("error" in r) results.push({ tool_use_id: u.id, name: u.name, content: r.error, is_error: true });
          else {
            accepted = r.value;
            results.push({ tool_use_id: u.id, name: u.name, content: "受理しました。" });
          }
          continue;
        }
        const t = spec.tool(u.name, u.input);
        if ("error" in t) {
          results.push({ tool_use_id: u.id, name: u.name, content: t.error, is_error: true });
          continue;
        }
        await sdo(step, `${tag}-progress`, async () => addProgress(env, p.sessionId, `${pre}-${turn}`, "info", `${u.name} を VPS で実行中`));
        try {
          const summary = await this.probe(step, p.sessionId, tag, t.req);
          results.push({ tool_use_id: u.id, name: u.name, content: truncateJson(t.summarize ? t.summarize(summary) : summary, 30000) });
        } catch (e) {
          results.push({ tool_use_id: u.id, name: u.name, content: `実行エラー: ${(e as Error).message}`, is_error: true });
        }
      }
      await sdo(step, `${pre}-turn-${turn}-results`, async () => {
        const msgs = (await (await env.BLOBS.get(key(`${turn}-a`)))!.json()) as Content[];
        if (results.length)
          msgs.push({
            role: "user",
            parts: results.map((r) => ({ functionResponse: { id: r.tool_use_id, name: r.name, response: r.is_error ? { error: r.content } : { output: r.content } } })),
          });
        else msgs.push({ role: "user", parts: [{ text: `検証が済んだら ${spec.submitName} ツールで提出してください。` }] });
        await env.BLOBS.put(key(String(turn + 1)), JSON.stringify(msgs));
      });
      if (accepted) return accepted;
    }
    throw new Error("AIの試行回数上限に達しました");
  }

  private async finalize(p: SetupParams, prop: Proposal, v1: Record<string, ValResult>, v2: Record<string, ValResult>, detail: DetailValidation | null) {
    const env = this.env;
    const m = prop.config.fetch.method;
    const main = v1[m];
    const again = v2[m];
    const other = m === "http" ? v1.browser : v1.http;
    const unverified = [...prop.unverified];
    const checks: { name: string; ok: boolean; detail: string }[] = [];
    if (!main || "error" in main) throw new Error(`検証実行に失敗: ${(main as { error?: string })?.error ?? "no result"}`);
    checks.push({ name: "取得・抽出", ok: main.outcome.extract_status === "success", detail: `${main.outcome.traversal} / ${main.outcome.end_reason}${main.outcome.error_detail ? " / " + main.outcome.error_detail : ""}` });
    checks.push({ name: "item件数", ok: main.item_count > 0, detail: `${main.item_count}件（有効 ${main.valid_items}）` });
    checks.push({ name: "識別キー", ok: main.identity_unique && main.identity_missing === 0, detail: main.identity_unique ? `一意（欠落 ${main.identity_missing}）` : "重複あり" });
    const sameKeys = !!again && !("error" in again) && JSON.stringify([...(again.all_keys ?? [])].sort()) === JSON.stringify([...(main.all_keys ?? [])].sort());
    checks.push({ name: "再実行での安定性", ok: sameKeys, detail: sameKeys ? "2回の実行で同じitem集合" : "2回の実行でitem集合が異なる" });
    if (other && !("error" in other)) {
      checks.push({ name: `${m === "http" ? "browser" : "http"}方式との比較`, ok: true, detail: `${m}: ${main.item_count}件 / ${m === "http" ? "browser" : "http"}: ${other.item_count}件（${other.outcome.extract_status}）` });
    }
    if (prop.config.paging.mode !== "none") {
      const pages = main.pages.length;
      if (!["no_next", "next_disabled"].includes(main.outcome.end_reason)) unverified.push(`最終ページまでは未到達（検証は${pages}ページで打ち切り）`);
    }
    if (prop.config.extract && !prop.config.extract.items.empty_marker && !unverified.some((u) => u.includes("0件"))) unverified.push("0件時の表示は未観測（empty_marker 未設定。container が残れば正常0件として扱う）");
    if (detail) {
      const rate = detail.page_count ? detail.ok_pages / detail.page_count : 0;
      checks.push({ name: "詳細ページの取得", ok: rate >= 0.8, detail: `${detail.ok_pages}/${detail.page_count} ページで取得` });
      const fill = Object.entries(detail.field_fill);
      checks.push({ name: "詳細ページのフィールド", ok: fill.some(([k, v]) => (k === "summary" || k === "content") && v >= 0.8), detail: fill.map(([k, v]) => `${k} ${Math.round(v * 100)}%`).join(" / ") });
    }
    const ff = main.field_fill;
    if (ff && ff.published_at < 0.5) unverified.push(`公開日時を取得できたitemは ${Math.round(ff.published_at * 100)}%`);

    // 修正提案：既存itemとの照合率
    let comparison: unknown = null;
    if (p.kind === "repair") {
      const ids = await schemeHash(identityScheme(prop.config));
      const keys = (main.all_keys ?? []).slice(0, 200);
      let matched = 0;
      for (let i = 0; i < keys.length; i += 50) {
        const ch = keys.slice(i, i + 50);
        const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM items WHERE subscription_id = ? AND identity_scheme = ? AND identity_key IN (${ch.map(() => "?").join(",")})`)
          .bind(p.subscriptionId, ids, ...ch)
          .first<{ n: number }>();
        matched += r?.n ?? 0;
      }
      comparison = { candidate_items: keys.length, matched_existing: matched, would_be_new: keys.length - matched };
    }

    const report = {
      kind: p.kind,
      origin: prop.origin,
      method: m,
      source_kind: prop.config.source.kind,
      rationale: prop.rationale,
      feed_assessment: prop.feed_assessment ?? null,
      unverified,
      checks,
      comparison,
      validation: { primary: main, secondary: other ?? null, rerun: again ?? null, detail },
      created_at: nowIso(),
    };
    const reportKey = `sessions/${p.sessionId}/report.json`;
    await env.BLOBS.put(reportKey, JSON.stringify(report));
    const cvId = newId();
    const last = await env.DB.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM config_versions WHERE subscription_id = ?").bind(p.subscriptionId).first<{ v: number }>();
    const parent = await env.DB.prepare("SELECT active_config_version_id FROM subscriptions WHERE id = ?").bind(p.subscriptionId).first<{ active_config_version_id: string | null }>();
    const cfgJson = JSON.stringify(prop.config);
    const summary = { checks, unverified, comparison, item_count: main.item_count, method: m };
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO config_versions (id, subscription_id, version, state, config_json, config_hash, identity_scheme_hash, hash_scheme_hash, origin, setup_session_id, parent_version_id, validation_report_key, validation_summary_json, note, created_at)
         VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        cvId,
        p.subscriptionId,
        (last?.v ?? 0) + 1,
        cfgJson,
        await schemeHash(prop.config),
        await schemeHash(identityScheme(prop.config)),
        await schemeHash(hashScheme(prop.config)),
        prop.origin,
        p.sessionId,
        parent?.active_config_version_id ?? null,
        reportKey,
        JSON.stringify(summary),
        prop.rationale.slice(0, 2000),
        nowIso(),
      ),
      env.DB.prepare("UPDATE setup_sessions SET status = 'ready', result_config_version_id = ?, report_key = ?, updated_at = ? WHERE id = ?").bind(cvId, reportKey, nowIso(), p.sessionId),
    ]);
    const ok = checks.filter((c) => c.ok).length;
    return { headline: `検証 ${ok}/${checks.length} 項目OK・${main.item_count}件・未検証 ${unverified.length}件`, cvId };
  }
}

interface DetailValidation {
  method: string;
  page_count: number;
  ok_pages: number;
  field_fill: Record<string, number>;
  pages: { url: string; ok: boolean; http_status?: number | null; error?: string; values?: unknown; failures?: unknown }[];
}

/** 一覧の item に本文がない：content が無く、summary も無いか短い */
function lacksContent(v: ValResult): boolean {
  if (v.item_count === 0 || (v.field_fill.content ?? 0) > 0) return false;
  if ((v.field_fill.summary ?? 0) < 0.5) return true;
  const items = v.items as { summary?: string }[];
  const lens = items.map((i) => (i.summary ?? "").length);
  return lens.reduce((a, b) => a + b, 0) / (lens.length || 1) < 60;
}

/** 詳細ページのサンプル：一覧の閲覧URLのうち購読先と同じサイトのもの */
function sampleDetailUrls(v: ValResult, siteUrl: string): string[] {
  const urls = (v.items as { link?: string }[]).map((i) => i.link).filter((u): u is string => !!u && /^https?:\/\//.test(u) && sameSite(u, siteUrl));
  return [...new Set(urls)].slice(0, 6);
}

interface ValResult {
  outcome: { traversal: string; end_reason: string; extract_status: string; error_detail: string | null };
  pages: unknown[];
  item_count: number;
  valid_items: number;
  identity_missing: number;
  identity_unique: boolean;
  field_fill: Record<string, number>;
  items: unknown[];
  all_keys: string[];
}

export async function startSession(env: Env, subscriptionId: string, kind: SetupParams["kind"], url: string, triggerRunId?: string): Promise<string> {
  const sid = newId();
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO setup_sessions (id, subscription_id, kind, status, workflow_instance_id, trigger_run_id, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, ?, ?, ?)").bind(
      sid,
      subscriptionId,
      kind,
      sid,
      triggerRunId ?? null,
      now,
      now,
    ),
    env.DB.prepare("UPDATE subscriptions SET current_setup_session_id = ?, updated_at = ? WHERE id = ?").bind(sid, now, subscriptionId),
  ]);
  await env.SETUP_WORKFLOW.create({ id: sid, params: { sessionId: sid, subscriptionId, kind, url, triggerRunId } satisfies SetupParams });
  return sid;
}
