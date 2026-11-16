// item のリンク先（詳細ページ）から、設定の抽出ルール（config.detail）で値を取得する
import { primaryLink, type DetailConfig, type ItemDetailResult, type SubmittedItem, type SubscriptionConfig } from "@ws/shared";
import { openPage, ws } from "./browser.js";
import { checkRobots, httpGet, FetchError } from "./net.js";
import { settings } from "./settings.js";
import { waitFor } from "./crawl.js";

const RUN_BUDGET_MS = 180_000;

export interface DetailFetch {
  /** undefined は一時的な失敗（取得済みにせず次回に再試行） */
  result: Omit<ItemDetailResult, "scheme"> | undefined;
  meta?: { title: string; description: string | null; og_title: string | null; og_description: string | null; og_image: string | null };
}

/** 詳細ページを1件取得して抽出する */
export async function fetchDetail(cfg: SubscriptionConfig, detail: DetailConfig, url: string, opts: { withMeta?: boolean } = {}): Promise<DetailFetch> {
  try {
    if (cfg.politeness.respect_robots_txt && !(await checkRobots(url)).allowed) return { result: { url, ok: false, http_status: null, error: "robots_disallowed" } };
    if (detail.fetch.method === "http") {
      const res = await httpGet(url, { headers: cfg.fetch.headers, timeoutMs: detail.fetch.timeout_ms, minIntervalMs: cfg.politeness.min_interval_ms, cacheTtlMs: settings.httpCacheLinkTtlMs });
      if (res.status >= 500 || res.status === 429 || res.status === 408) return { result: undefined };
      if (res.status < 200 || res.status >= 300) return { result: { url, ok: false, http_status: res.status, error: `http_status_${res.status}` } };
      const op = await openPage(cfg, "static", { url: res.url, status: res.status, body: res.body, headers: res.headers });
      try {
        await op.page.goto(res.url, { waitUntil: "domcontentloaded", timeout: detail.fetch.timeout_ms });
        return await evaluate(op.page, detail, url, res.status, res.url, cfg.timezone, opts.withMeta);
      } finally {
        await op.close();
      }
    }
    const op = await openPage(cfg, "browser");
    try {
      try {
        await op.page.goto(url, { waitUntil: "domcontentloaded", timeout: detail.fetch.timeout_ms });
      } catch {
        return { result: undefined }; // ナビゲーション失敗は一時的な失敗として次回に回す
      }
      const main = op.lastMainResponse();
      if (!main || main.status >= 500 || main.status === 429) return { result: undefined };
      if (main.status < 200 || main.status >= 300) return { result: { url, ok: false, http_status: main.status, error: `http_status_${main.status}` } };
      const w = await waitFor(op.page, cfg, detail.wait, null);
      if (!w.ok) return { result: { url, ok: false, http_status: main.status, error: `wait_timeout: ${w.detail}` } };
      return await evaluate(op.page, detail, url, main.status, op.page.url(), cfg.timezone, opts.withMeta);
    } finally {
      await op.close();
    }
  } catch (e) {
    if (e instanceof FetchError && e.retryable) return { result: undefined };
    return { result: { url, ok: false, http_status: null, error: (e as Error).message.split("\n")[0] } };
  }
}

async function evaluate(page: import("playwright").Page, detail: DetailConfig, url: string, status: number, finalUrl: string, timezone: string, withMeta?: boolean): Promise<DetailFetch> {
  const r = await ws(page, "extractDetail", detail.fields, timezone, finalUrl);
  const required = Object.entries(detail.fields).filter(([, rule]) => (rule as { required?: boolean }).required).map(([k]) => k);
  const missingRequired = r.failures.some((f) => required.includes(f.field) || f.status === "error");
  const anyValue = r.failures.length < Object.keys(detail.fields).length;
  const meta = withMeta ? await ws(page, "pageMeta") : undefined;
  return {
    result: { url, ok: anyValue && !missingRequired, http_status: status, data: r.data, failures: r.failures, ...(missingRequired ? { error: "required_field_missing" } : !anyValue ? { error: "no_field_matched" } : {}) },
    meta,
  };
}

function needsDetail(it: SubmittedItem, when: DetailConfig["when"]): boolean {
  if (when === "always") return true;
  return !it.data.summary?.value && !it.data.content;
}

/** クロール中に新しい item の詳細ページを取得する */
export class DetailEnricher {
  tried = 0;
  ok = 0;
  private skip: Set<string>;
  private deadline = Date.now() + RUN_BUDGET_MS;

  constructor(
    private cfg: SubscriptionConfig,
    private instr: { scheme: string; skip_keys: string[] },
  ) {
    this.skip = new Set(instr.skip_keys);
  }

  stats() {
    return { tried: this.tried, ok: this.ok };
  }

  async enrich(items: SubmittedItem[]): Promise<void> {
    const detail = this.cfg.detail;
    if (!detail) return;
    for (const it of items) {
      if (this.tried >= detail.max_per_run || Date.now() > this.deadline) return;
      if (!it.valid || !it.identity_key || this.skip.has(it.identity_key)) continue;
      if (!needsDetail(it, detail.when)) continue;
      const link = primaryLink(it.data);
      if (!link || !/^https?:\/\//.test(link)) continue;
      this.skip.add(it.identity_key);
      const { result } = await fetchDetail(this.cfg, detail, link);
      if (!result) continue;
      this.tried++;
      if (result.ok) this.ok++;
      it.detail = { scheme: this.instr.scheme, ...result };
    }
  }
}
