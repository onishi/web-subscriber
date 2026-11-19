// セットの公開ページ（認証なし）。本番は PUBLIC_HOST（radar.wagaya.org）の /<slug>、開発時は /p/<slug>
// フィードリーダーではなく「特定カテゴリの新着情報一覧」として、サーバー側で HTML を組み立てて返す。
import { Hono } from "hono";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { type Env, json } from "./env.js";
import { displayValue, loadFields, type SetField } from "./fields.js";

export type PublicLayout = "list" | "cards" | "compact" | "table";
/** タブ：区分の id、または all（すべて） */
export type PublicTab = string;
/** 並べ替えのキー：published（日付）/ first_seen（収集日）/ title / f:<フィールドのキー> */
export interface PublicSort {
  key: string;
  dir: "asc" | "desc";
}
export interface PublicOptions {
  /** 表示するカスタムフィールドのキー（この順で表示。期間に使うキーは期間としてまとめて表示） */
  fields?: string[];
  /** 期間（開始・終了の日付フィールド）。「期間」の表示と並び順（期間の開始・終了）に使う */
  period?: { start: string; end: string } | null;
  /**
   * 区分。上から順に条件を見て、最初に当てはまった区分に入れる（下の区分には出さない）。
   * 区分ごとにタブ・バッジ・非表示を選べる。未指定で period があれば「開催中 / これから」を組み立てる（以前の設定との互換）
   */
  sections?: PublicSection[];
  /** 「すべて」タブを出すか（未指定は出す）。区分のタブがなければ常に「すべて」だけ */
  all_tab?: boolean;
  /** 絞り込みチップに使う複数値（または テキスト）フィールド */
  facet?: string | null;
  layout?: PublicLayout;
  /**
   * 表示する項目とその順番。date / source / title / period / excerpt / f:<フィールドのキー>。
   * 未指定なら show と fields から組み立てる（以前の設定との互換）
   */
  display?: string[];
  /** 標準項目の表示（未指定は表示）。display があるときは image だけを使う */
  show?: { date?: boolean; source?: boolean; period?: boolean; excerpt?: boolean; image?: boolean };
  excerpt_length?: number;
  per_page?: number;
  /** タブごとの並び順（区分の id または all） */
  sort?: Record<string, PublicSort>;
  default_tab?: PublicTab;
  /** すべてのタブにかかる絞り込み条件（すべて満たすものだけを表示） */
  filters?: PublicFilter[];
}
/**
 * 絞り込み条件。key は published（日付）/ image / excerpt（概要）/ f:<フィールドのキー>。
 * op：not_empty / empty（共通）、future（未来：今日を含む）/ past（過去：昨日まで）（日付）、
 * eq / ne（テキスト・複数値。value と一致する値がある / ない）、gte / lte（数値）、true / false（真偽）
 */
export interface PublicFilter {
  key: string;
  op: FilterOp;
  value?: string | number;
}
export type FilterOp = "not_empty" | "empty" | "future" | "past" | "until_today" | "next_days" | "last_days" | "eq" | "ne" | "gte" | "lte" | "true" | "false";
/** 区分：名前と条件（すべてを満たすと当てはまる。条件なしは何にでも当てはまる） */
export interface PublicSection {
  /** タブの URL（?tab=）と並び順のキー */
  id: string;
  label: string;
  conditions: PublicFilter[];
  /** タブにする */
  tab: boolean;
  /** 当てはまった情報にバッジ（ラベル）を付ける */
  badge: boolean;
  /** どのタブにも出さない（「すべて」からも外す） */
  hidden: boolean;
}
const SECTION_ID_RE = /^[a-z0-9_-]{1,24}$/;

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const LAYOUTS: PublicLayout[] = ["list", "cards", "compact", "table"];
const DEFAULT_SORT: Record<string, PublicSort> = { now: { key: "period_end", dir: "asc" }, upcoming: { key: "period_start", dir: "asc" }, all: { key: "published", dir: "desc" } };
/** 項目の種類ごとに使える条件 */
export const FILTER_OPS: Record<"date" | "text" | "list" | "number" | "boolean" | "plain", FilterOp[]> = {
  date: ["not_empty", "empty", "future", "past", "until_today", "next_days", "last_days"],
  text: ["not_empty", "empty", "eq", "ne"],
  list: ["not_empty", "empty", "eq", "ne"],
  number: ["not_empty", "empty", "gte", "lte"],
  boolean: ["not_empty", "empty", "true", "false"],
  plain: ["not_empty", "empty"],
};
const filterKind = (key: string, keys: Map<string, SetField>): keyof typeof FILTER_OPS | null =>
  key === "published" ? "date" : key === "image" || key === "excerpt" ? "plain" : key.startsWith("f:") ? (keys.get(key.slice(2))?.type ?? null) : null;
const clampInt = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d);

/** 保存時・表示時の両方で使う。存在しないフィールドや不正な値は捨てて既定値に寄せる */
export function normalizePublicOptions(o: PublicOptions | null | undefined, fields: SetField[]): Required<Omit<PublicOptions, "period" | "facet">> & Pick<PublicOptions, "period" | "facet"> {
  o = o ?? {};
  const keys = new Map(fields.map((f) => [f.key, f]));
  const period = o.period && keys.get(o.period.start)?.type === "date" && keys.get(o.period.end)?.type === "date" ? { start: o.period.start, end: o.period.end } : null;
  const sortKeyOk = (k: unknown) =>
    typeof k === "string" && (["published", "first_seen", "title"].includes(k) || (period && (k === "period_start" || k === "period_end")) || (k.startsWith("f:") && keys.has(k.slice(2))));
  const normFilters = (xs: unknown, max: number) => (Array.isArray(xs) ? xs.slice(0, max) : []).map((x) => normalizeFilter(x, keys)).filter((x): x is PublicFilter => !!x);
  // 区分（未指定なら以前の「期間」の設定から開催中 / これからを組み立てる）
  const sections: PublicSection[] = [];
  const rawSections: unknown[] = Array.isArray(o.sections)
    ? o.sections
    : period
      ? [
          { id: "now", label: "開催中", conditions: [{ key: `f:${period.start}`, op: "until_today" }, { key: `f:${period.end}`, op: "future" }], tab: true },
          { id: "upcoming", label: "これから", conditions: [{ key: `f:${period.start}`, op: "future" }], tab: true },
        ]
      : [];
  for (const x of rawSections.slice(0, 8) as Partial<PublicSection>[]) {
    if (!x || typeof x.id !== "string" || !SECTION_ID_RE.test(x.id) || x.id === "all" || sections.some((y) => y.id === x.id)) continue;
    const label = typeof x.label === "string" ? x.label.trim().slice(0, 20) : "";
    if (!label) continue;
    sections.push({ id: x.id, label, conditions: normFilters(x.conditions, 6), tab: !!x.tab && !x.hidden, badge: !!x.badge && !x.hidden, hidden: !!x.hidden });
  }
  const tabs = [...sections.filter((x) => x.tab).map((x) => x.id), ...(o.all_tab !== false || !sections.some((x) => x.tab) ? ["all"] : [])];
  const sort: Record<string, PublicSort> = {};
  for (const t of tabs) {
    const x = o.sort?.[t];
    const d = DEFAULT_SORT[t] && (t === "all" || period) ? DEFAULT_SORT[t] : DEFAULT_SORT.all;
    sort[t] = x && sortKeyOk(x.key) ? { key: x.key, dir: x.dir === "asc" ? "asc" : "desc" } : d;
  }
  const show = o.show ?? {};
  const itemOk = (k: unknown): k is string =>
    typeof k === "string" && (["date", "source", "title", "excerpt"].includes(k) || (k === "period" && !!period) || (k.startsWith("f:") && keys.has(k.slice(2))));
  let display: string[];
  if (Array.isArray(o.display)) display = [...new Set(o.display.filter(itemOk))];
  else {
    // 以前の設定（show + fields）から組み立てる
    display = [
      ...(show.date !== false ? ["date"] : []),
      ...(show.source !== false ? ["source"] : []),
      "title",
      ...(period && show.period !== false ? ["period"] : []),
      ...(show.excerpt !== false ? ["excerpt"] : []),
      ...(o.fields ?? []).filter((k) => keys.has(k) && k !== period?.start && k !== period?.end).map((k) => `f:${k}`),
    ];
  }
  if (!display.includes("title")) display.unshift("title"); // タイトルは必ず出す
  const filters = normFilters(o.filters, 10);
  return {
    display,
    fields: display.filter((k) => k.startsWith("f:")).map((k) => k.slice(2)),
    period,
    facet: o.facet && ["list", "text"].includes(keys.get(o.facet)?.type ?? "") ? o.facet : null,
    layout: LAYOUTS.includes(o.layout as PublicLayout) ? (o.layout as PublicLayout) : "list",
    show: { date: display.includes("date"), source: display.includes("source"), period: display.includes("period"), excerpt: display.includes("excerpt"), image: show.image !== false },
    excerpt_length: clampInt(o.excerpt_length, 20, 400, 140),
    per_page: clampInt(o.per_page, 10, 100, 30),
    sort,
    sections,
    all_tab: tabs.includes("all"),
    default_tab: tabs.includes(o.default_tab as string) ? (o.default_tab as string) : tabs[0],
    filters,
  };
}

/** 条件を1つ検証する（不正なら null） */
function normalizeFilter(x: unknown, keys: Map<string, SetField>): PublicFilter | null {
  const f = x as Partial<PublicFilter> | null;
  const kind = f && typeof f.key === "string" ? filterKind(f.key, keys) : null;
  if (!f || !kind || !FILTER_OPS[kind].includes(f.op as FilterOp)) return null;
  const key = f.key as string;
  if (f.op === "eq" || f.op === "ne") {
    const value = typeof f.value === "string" ? f.value.trim().slice(0, 100) : "";
    return value ? { key, op: f.op, value } : null;
  }
  if (f.op === "gte" || f.op === "lte" || f.op === "next_days" || f.op === "last_days") {
    const value = typeof f.value === "number" ? f.value : Number(f.value);
    if (f.value === "" || f.value == null || !Number.isFinite(value)) return null;
    return { key, op: f.op, value: f.op === "next_days" || f.op === "last_days" ? Math.max(0, Math.min(3650, Math.round(value))) : value };
  }
  return { key, op: f.op as FilterOp };
}

type H = HtmlEscapedString | Promise<HtmlEscapedString>;

const safeUrl = (u: unknown): string | null => (typeof u === "string" && /^https?:\/\//i.test(u) ? u : null);
const stripTags = (s: string) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#8230;/g, "…")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/\s+/g, " ")
    .trim();
const excerpt = (s: string | null, n = 140) => {
  if (!s) return null;
  const t = stripTags(s);
  return t.length > n ? t.slice(0, n) + "…" : t;
};
const jstToday = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const fmtDate = (d: string | null | undefined) => (d ? d.slice(0, 10).replace(/-/g, ".") : "");
const fmtJst = (iso: string | null) => (iso ? new Date(Date.parse(iso) + 9 * 3600000).toISOString().slice(0, 16).replace("T", " ").replace(/-/g, ".") : "");

export const publicPages = new Hono<{ Bindings: Env }>();

publicPages.get("/", async (c) => {
  const rs = await c.env.DB.prepare(
    `SELECT st.public_slug AS slug, COALESCE(NULLIF(st.public_title, ''), st.name) AS title, st.public_description AS description,
       (SELECT COUNT(*) FROM set_members m JOIN subscriptions s ON s.id = m.subscription_id WHERE m.set_id = st.id AND s.status != 'archived') AS sources,
       (SELECT MAX(s.last_success_at) FROM set_members m JOIN subscriptions s ON s.id = m.subscription_id WHERE m.set_id = st.id AND s.status != 'archived') AS updated
     FROM sets st WHERE st.is_public = 1 AND st.public_slug IS NOT NULL ORDER BY st.position, st.created_at`,
  ).all<{ slug: string; title: string; description: string | null; sources: number; updated: string | null }>();
  c.header("Cache-Control", "public, max-age=300");
  return c.html(
    layout(
      "radar",
      "いろいろなサイトの新着情報を、テーマごとに集めて一覧にしています。",
      html`
        <header class="hero">
          <div class="wrap">
            <h1>radar</h1>
            <p class="lead">いろいろなサイトの新着情報を、テーマごとに集めて一覧にしています。</p>
          </div>
        </header>
        <main class="wrap">
          ${rs.results.length === 0
            ? html`<p class="empty">公開中のページはまだありません。</p>`
            : html`<ul class="entries">
                ${rs.results.map(
                  (r) => html`<li class="entry">
                    <a class="entry-link" href="./${r.slug}">
                      <div class="entry-body">
                        <h2 class="entry-title">${r.title}</h2>
                        ${r.description ? html`<p class="excerpt">${r.description}</p>` : ""}
                        <div class="entry-meta">${r.sources} の情報源${r.updated ? html`・最終更新 ${fmtJst(r.updated)}` : ""}</div>
                      </div>
                    </a>
                  </li>`,
                )}
              </ul>`}
        </main>
      `,
    ),
  );
});

publicPages.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  const st = await c.env.DB.prepare("SELECT * FROM sets WHERE public_slug = ?").bind(slug).first<Record<string, string | number | null>>();
  if (!st) return c.html(notFound(), 404);
  // 非公開のセットは、?token= がプレビュー用トークンと一致するときだけ見せる
  const token = c.req.query("token") ?? "";
  const preview = !st.is_public;
  if (preview && !(typeof st.public_preview_token === "string" && token && safeEqual(token, st.public_preview_token))) return c.html(notFound(), 404);
  const fields = await loadFields(c.env, st.id as string);
  const opts = normalizePublicOptions(json<PublicOptions>(st.public_options_json as string | null, {}), fields);
  const PER_PAGE = opts.per_page;
  const show = opts.show;
  const kind = opts.layout;
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const period = opts.period && byKey.get(opts.period.start)?.type === "date" && byKey.get(opts.period.end)?.type === "date" ? { start: byKey.get(opts.period.start)!, end: byKey.get(opts.period.end)! } : null;
  const facet = opts.facet ? byKey.get(opts.facet) ?? null : null;
  const shown = opts.fields.map((k) => byKey.get(k)).filter((f): f is SetField => !!f);

  const today = jstToday();
  const sections = opts.sections;
  const tabs = [...sections.filter((x) => x.tab).map((x) => ({ id: x.id, label: x.label })), ...(opts.all_tab ? [{ id: "all", label: "すべて" }] : [])];
  const qTab = c.req.query("tab");
  const tab: PublicTab = tabs.some((t) => t.id === qTab) ? qTab! : opts.default_tab;
  const facetValue = facet ? c.req.query("v") ?? "" : "";
  const page = Math.max(1, Math.min(100, Number(c.req.query("page") ?? 1) || 1));

  const where = ["i.subscription_id IN (SELECT m.subscription_id FROM set_members m JOIN subscriptions s ON s.id = m.subscription_id WHERE m.set_id = ? AND s.status != 'archived')", "(i.title_text IS NOT NULL OR i.primary_link IS NOT NULL)"];
  const args: unknown[] = [st.id];
  const col = (f: SetField) => (f.type === "date" ? "value_date" : f.type === "number" || f.type === "boolean" ? "value_num" : "value_text");
  const v = (f: SetField, agg: "MIN" | "MAX") => `(SELECT ${agg}(${col(f)}) FROM item_field_values WHERE item_id = i.id AND field_id = '${f.id.replace(/[^0-9A-Za-z]/g, "")}')`;
  const IMAGE = "COALESCE(i.image_url, json_extract(i.detail_json, '$.native.extracted_fields.image'))";
  const SUMMARY =
    "COALESCE(json_extract(i.detail_json, '$.summary.value'), json_extract(i.data_json, '$.summary.value'), json_extract(i.detail_json, '$.content.value'), json_extract(i.data_json, '$.content.value'))";
  const cond = (fl: PublicFilter) => filterSql(fl, byKey, today, { image: IMAGE, summary: SUMMARY, col });
  // 設定された絞り込み条件（すべてのタブにかかる）
  for (const fl of opts.filters) {
    const x = cond(fl);
    if (!x) continue;
    where.push(x.sql);
    args.push(...x.args);
  }
  // 区分：上から順に見て最初に当てはまった区分の番号（どれにも当てはまらなければ区分の数）
  let secSql = "";
  const secArgs: unknown[] = [];
  if (sections.length) {
    const whens = sections.map((sec, k) => {
      const parts = sec.conditions.map(cond).filter((x): x is { sql: string; args: unknown[] } => !!x);
      for (const p of parts) secArgs.push(...p.args);
      return `WHEN ${parts.length ? parts.map((p) => `(${p.sql})`).join(" AND ") : "1"} THEN ${k}`;
    });
    secSql = `(CASE ${whens.join(" ")} ELSE ${sections.length} END)`;
    const tabIdx = sections.findIndex((x) => x.id === tab);
    if (tabIdx >= 0) {
      where.push(`${secSql} = ${tabIdx}`);
      args.push(...secArgs);
    } else {
      const hidden = sections.flatMap((x, k) => (x.hidden ? [k] : []));
      if (hidden.length) {
        where.push(`${secSql} NOT IN (${hidden.join(",")})`);
        args.push(...secArgs);
      }
    }
  }
  // 並び順：値のないものは常に後ろ
  const sort = opts.sort[tab] ?? DEFAULT_SORT.all;
  const dir = sort.dir === "asc" ? "ASC" : "DESC";
  const agg = sort.dir === "asc" ? "MIN" : "MAX";
  const sortExpr =
    sort.key === "title"
      ? "TRIM(i.title_text, char(32, 9, 10, 13, 12288))"
      : sort.key === "first_seen"
        ? "i.first_seen_at"
        : sort.key === "period_start" && period
          ? v(period.start, "MIN")
          : sort.key === "period_end" && period
            ? `COALESCE(${v(period.end, "MAX")}, ${v(period.start, "MIN")})`
            : sort.key.startsWith("f:") && byKey.has(sort.key.slice(2))
              ? v(byKey.get(sort.key.slice(2))!, agg)
              : "COALESCE(i.published_sort, i.first_seen_at)";
  const order = `(${sortExpr}) IS NULL, ${sortExpr} ${dir}, COALESCE(i.published_sort, i.first_seen_at) DESC, i.id DESC`;
  if (facet && facetValue) {
    where.push("EXISTS (SELECT 1 FROM item_field_values fv WHERE fv.item_id = i.id AND fv.field_id = ? AND fv.value_text = ?)");
    args.push(facet.id, facetValue);
  }
  // DB との往復を減らすため、互いに依存しない問い合わせはまとめて投げる
  const [rs, sources, chipRows] = await Promise.all([
    c.env.DB.prepare(
    `SELECT i.id, i.subscription_id, i.title_text, i.primary_link, i.first_seen_at, i.last_changed_at,
       ${IMAGE} AS image,
       ${SUMMARY} AS summary,
       COALESCE(json_extract(i.detail_json, '$.published_at.value'), json_extract(i.data_json, '$.published_at.value')) AS published,
       ${secSql || "NULL"} AS sec
     FROM items i WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`,
  )
    .bind(...(secSql ? secArgs : []), ...args, PER_PAGE + 1, (page - 1) * PER_PAGE)
    .all<{ id: string; subscription_id: string; title_text: string | null; primary_link: string | null; first_seen_at: string; last_changed_at: string | null; image: string | null; summary: string | null; published: string | null; sec: number | null }>(),
    // 情報源（購読先）
    c.env.DB.prepare(
    `SELECT s.id, s.input_url, s.last_success_at, COALESCE(s.display_title, json_extract(ch.data_json, '$.title.value'), s.input_url) AS title, json_extract(ch.data_json, '$.logo.url') AS logo,
       (SELECT json_extract(value, '$.href') FROM json_each(ch.data_json, '$.links') WHERE json_extract(value, '$.rel') = 'alternate' LIMIT 1) AS home
     FROM set_members m JOIN subscriptions s ON s.id = m.subscription_id LEFT JOIN channels ch ON ch.subscription_id = s.id
     WHERE m.set_id = ? AND s.status != 'archived' ORDER BY m.added_at`,
  )
    .bind(st.id)
    .all<{ id: string; input_url: string; last_success_at: string | null; title: string; logo: string | null; home: string | null }>(),
    // 絞り込みチップ
    facet
      ? c.env.DB.prepare("SELECT value_text AS value, COUNT(DISTINCT item_id) AS count FROM item_field_values WHERE field_id = ? AND value_text IS NOT NULL GROUP BY value_text ORDER BY count DESC LIMIT 30")
          .bind(facet.id)
          .all<{ value: string; count: number }>()
      : null,
  ]);
  const items = rs.results.slice(0, PER_PAGE);
  const src = new Map(sources.results.map((s) => [s.id, s]));
  const updated = sources.results.map((s) => s.last_success_at).filter(Boolean).sort().pop() ?? null;
  const chips: { value: string; count: number }[] = chipRows?.results ?? [];

  // カスタムフィールドの値
  const valueFields = [...shown, ...(period ? [period.start, period.end] : [])];
  const values = new Map<string, Map<string, unknown[]>>();
  if (items.length && valueFields.length) {
    const vr = await c.env.DB.prepare(
      `SELECT item_id, field_id, value_text, value_num, value_date FROM item_field_values WHERE item_id IN (${items.map(() => "?").join(",")}) AND field_id IN (${valueFields.map(() => "?").join(",")}) ORDER BY ord`,
    )
      .bind(...items.map((i) => i.id), ...valueFields.map((f) => f.id))
      .all<{ item_id: string; field_id: string; value_text: string | null; value_num: number | null; value_date: string | null }>();
    const fById = new Map(valueFields.map((f) => [f.id, f]));
    for (const r of vr.results) {
      const m = values.get(r.item_id) ?? new Map<string, unknown[]>();
      const f = fById.get(r.field_id)!;
      m.set(f.key, [...(m.get(f.key) ?? []), displayValue(f.type, r)]);
      values.set(r.item_id, m);
    }
  }


  const title = (st.public_title as string) || (st.name as string);
  const description = (st.public_description as string) || "";
  const q = (o: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    const all = { token: preview ? token : undefined, tab: tabs.length > 1 ? tab : undefined, v: facetValue || undefined, ...o };
    for (const [k, val] of Object.entries(all)) if (val !== undefined && val !== "" && !(k === "page" && String(val) === "1")) p.set(k, String(val));
    const s = p.toString();
    return s ? `?${s}` : "?";
  };
  const fmtVal = (f: SetField, vals: unknown[]) => vals.map((x) => (f.type === "date" ? fmtDate(String(x)) : f.type === "boolean" ? (x ? "はい" : "いいえ") : String(x))).join("・");

  const view = (it: (typeof items)[number]) => {
    const s = src.get(it.subscription_id);
    const vals = values.get(it.id);
    const ps = period && vals?.get(period.start.key)?.[0];
    const pe = period && vals?.get(period.end.key)?.[0];
    const date = it.published ?? it.first_seen_at;
    const sec = it.sec != null ? sections[it.sec] : undefined;
    return {
      s,
      badge: sec?.badge ? html`<span class="sec-badge">${sec.label}</span>` : "",
      link: safeUrl(it.primary_link),
      img: show.image ? safeUrl(it.image) : null,
      title: it.title_text ?? it.primary_link,
      vals,
      dateEl: show.date ? html`<time datetime="${date.slice(0, 10)}">${fmtDate(date)}</time>` : "",
      sourceEl: show.source && s ? html`<span class="source">${safeUrl(s.logo) ? html`<img src="${safeUrl(s.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ""}${s.title}</span>` : "",
      periodText: show.period && (ps || pe) ? `${fmtDate(String(ps ?? ""))}${pe && pe !== ps ? ` – ${fmtDate(String(pe))}` : ""}` : "",
      ex: show.excerpt ? excerpt(it.summary, opts.excerpt_length) : null,
    };
  };
  const wrapLink = (link: string | null, cls: string, body: H) =>
    link ? html`<a class="${cls}" href="${link}" target="_blank" rel="noopener">${body}</a>` : html`<div class="${cls}">${body}</div>`;
  const fieldOf = (k: string) => (k.startsWith("f:") ? byKey.get(k.slice(2)) ?? null : null);
  const fieldText = (x: ReturnType<typeof view>, f: SetField) => (x.vals?.get(f.key)?.length ? fmtVal(f, x.vals.get(f.key)!) : "");

  /** 設定の順に並べる。日付・情報源は続けて1行に、カスタムフィールドは続けて1つの一覧にまとめる */
  const blocks = (x: ReturnType<typeof view>): H[] => {
    const out: H[] = [];
    let meta: H[] = [];
    let dl: H[] = [];
    const flush = () => {
      if (meta.length) out.push(html`<div class="entry-meta">${meta}</div>`);
      if (dl.length) out.push(html`<dl class="fields">${dl}</dl>`);
      meta = [];
      dl = [];
    };
    for (const k of opts.display) {
      const f = fieldOf(k);
      if (k === "date" || k === "source") {
        if (dl.length) flush();
        const el = k === "date" ? x.dateEl : x.sourceEl;
        if (el) meta.push(el as H);
        continue;
      }
      if (f) {
        if (meta.length) flush();
        const t = fieldText(x, f);
        if (t) dl.push(html`<div><dt>${f.label}</dt><dd>${t}</dd></div>`);
        continue;
      }
      flush();
      if (k === "title") out.push(html`<h2 class="entry-title">${x.badge}${x.title}</h2>`);
      else if (k === "period" && x.periodText) out.push(html`<p class="period">${x.periodText}</p>`);
      else if (k === "excerpt" && x.ex) out.push(html`<p class="excerpt">${x.ex}</p>`);
    }
    flush();
    return out;
  };

  const entry = (it: (typeof items)[number]) => {
    const x = view(it);
    if (kind === "compact") {
      const parts = opts.display.map((k) => {
        const f = fieldOf(k);
        if (f) {
          const t = fieldText(x, f);
          return t ? html`<span class="row-field">${t}</span>` : "";
        }
        if (k === "date") return html`<span class="row-date">${x.dateEl}</span>`;
        if (k === "period") return html`<span class="row-date row-period">${x.periodText}</span>`;
        if (k === "title") return html`<span class="row-title">${x.badge}${x.title}</span>`;
        if (k === "source") return x.sourceEl ? html`<span class="row-source">${x.sourceEl}</span>` : "";
        if (k === "excerpt") return x.ex ? html`<span class="row-excerpt">${x.ex}</span>` : "";
        return "";
      });
      return html`<li class="row-item">${wrapLink(x.link, "row-link", html`${parts}`)}</li>`;
    }
    if (kind === "cards") {
      return html`<li class="card">${wrapLink(
        x.link,
        "card-link",
        html`${x.img ? html`<img class="card-img" src="${x.img}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />` : ""}
          <div class="card-body">${blocks(x)}</div>`,
      )}</li>`;
    }
    return html`<li class="entry">${wrapLink(
      x.link,
      "entry-link",
      html`<div class="entry-body">${blocks(x)}</div>
        ${x.img ? html`<img class="thumb" src="${x.img}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />` : ""}`,
    )}</li>`;
  };

  const COL_LABEL: Record<string, string> = { date: "日付", source: "情報源", title: "タイトル", period: "期間", excerpt: "概要" };
  const table = () => html`<div class="table-wrap">
    <table class="entries-table">
      <thead>
        <tr>
          ${opts.display.map((k) => html`<th>${fieldOf(k)?.label ?? COL_LABEL[k] ?? ""}</th>`)}
        </tr>
      </thead>
      <tbody>
        ${items.map((it) => {
          const x = view(it);
          return html`<tr>
            ${opts.display.map((k) => {
              const f = fieldOf(k);
              if (f) return html`<td>${fieldText(x, f)}</td>`;
              if (k === "date") return html`<td class="nowrap">${x.dateEl}</td>`;
              if (k === "period") return html`<td class="nowrap">${x.periodText}</td>`;
              if (k === "title") return html`<td class="t-title">${x.badge}${x.link ? html`<a href="${x.link}" target="_blank" rel="noopener">${x.title}</a>` : x.title}</td>`;
              if (k === "source") return html`<td>${x.sourceEl}</td>`;
              if (k === "excerpt") return html`<td class="t-excerpt">${x.ex ?? ""}</td>`;
              return html`<td></td>`;
            })}
          </tr>`;
        })}
      </tbody>
    </table>
  </div>`;

  const listEl = () =>
    kind === "table" ? table() : kind === "cards" ? html`<ol class="cards">${items.map(entry)}</ol>` : kind === "compact" ? html`<ol class="rows">${items.map(entry)}</ol>` : html`<ol class="entries">${items.map(entry)}</ol>`;

  c.header("Cache-Control", "public, max-age=300");
  if (preview) {
    // トークンが外部サイトへの Referer や共有キャッシュに漏れないように
    c.header("Cache-Control", "private, no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Robots-Tag", "noindex, nofollow");
  }
  return c.html(
    layout(
      title,
      description,
      html`
        ${preview ? html`<div class="preview-bar">プレビュー：このページは非公開です。この URL を知っている人だけが見られます。</div>` : ""}
        <header class="hero">
          <div class="wrap">
            <a class="brand" href="./">radar</a>
            <h1>${title}</h1>
            ${description ? html`<p class="lead">${description}</p>` : ""}
            <p class="meta">${sources.results.length} の情報源から自動で収集${updated ? html`・最終更新 ${fmtJst(updated)}` : ""}</p>
          </div>
        </header>
        <main class="wrap">
          ${tabs.length > 1
            ? html`<nav class="tabs" aria-label="区分">
                ${tabs.map((t) => html`<a href="${q({ tab: t.id, page: 1 })}" class="${tab === t.id ? "on" : ""}" ${tab === t.id ? raw('aria-current="page"') : ""}>${t.label}</a>`)}
              </nav>`
            : ""}
          ${chips.length
            ? html`<nav class="chips" aria-label="${facet!.label}">
                <a href="${q({ v: undefined, page: 1 })}" class="${facetValue ? "" : "on"}">すべて</a>
                ${chips.map((ch) => html`<a href="${q({ v: ch.value, page: 1 })}" class="${facetValue === ch.value ? "on" : ""}">${ch.value}<span>${ch.count}</span></a>`)}
              </nav>`
            : ""}
          ${items.length ? listEl() : html`<p class="empty">${tab === "all" ? "まだ情報がありません。" : `「${tabs.find((t) => t.id === tab)?.label ?? ""}」に当てはまる情報はありません。`}</p>`}
          ${page > 1 || rs.results.length > PER_PAGE
            ? html`<nav class="pager">
                ${page > 1 ? html`<a href="${q({ page: page - 1 })}">← 前へ</a>` : html`<span></span>`}
                <span>${page} ページ</span>
                ${rs.results.length > PER_PAGE ? html`<a href="${q({ page: page + 1 })}">次へ →</a>` : html`<span></span>`}
              </nav>`
            : ""}
          <footer class="sources">
            <h3>情報源</h3>
            <ul>
              ${sources.results.map((s) => html`<li><a href="${safeUrl(s.home) ?? safeUrl(s.input_url) ?? "#"}" target="_blank" rel="noopener">${s.title}</a></li>`)}
            </ul>
            <p>各情報の内容は情報源のサイトでご確認ください。このページは各サイトの公開情報を自動で収集・整理しています。</p>
          </footer>
        </main>
      `,
    ),
  );
});

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/**
 * 条件1つ分の SQL（items i を参照）。日付は日本時間の今日（today）と比べる。
 * future：今日以降 / past：昨日まで（値があり、すべて今日より前）/ until_today：今日まで / next_days：今日から N 日後まで / last_days：N 日前から今日まで
 */
function filterSql(
  fl: PublicFilter,
  byKey: Map<string, SetField>,
  today: string,
  x: { image: string; summary: string; col: (f: SetField) => string },
): { sql: string; args: unknown[] } | null {
  const n = Number(fl.value ?? 0);
  // 日付の比較：[比較式, 引数]
  const dateCmp = (e: string): [string, unknown[]] | null => {
    switch (fl.op) {
      case "future":
        return [`${e} >= ?`, [today]];
      case "until_today":
        return [`${e} <= ?`, [today]];
      case "next_days":
        return [`${e} BETWEEN ? AND ?`, [today, addDays(today, n)]];
      case "last_days":
        return [`${e} BETWEEN ? AND ?`, [addDays(today, -n), today]];
      default:
        return null;
    }
  };
  if (fl.key === "image" || fl.key === "excerpt") {
    const e = fl.key === "image" ? x.image : x.summary;
    return { sql: fl.op === "empty" ? `COALESCE(${e}, '') = ''` : `COALESCE(${e}, '') != ''`, args: [] };
  }
  if (fl.key === "published") {
    const d = "date(i.published_sort, '+9 hours')"; // 日本時間の日付で比べる
    if (fl.op === "empty") return { sql: "i.published_sort IS NULL", args: [] };
    if (fl.op === "not_empty") return { sql: "i.published_sort IS NOT NULL", args: [] };
    if (fl.op === "past") return { sql: `${d} < ?`, args: [today] };
    const c = dateCmp(d);
    return c ? { sql: c[0], args: c[1] } : null;
  }
  const f = byKey.get(fl.key.slice(2));
  if (!f) return null;
  const has = (cond: string) => `EXISTS (SELECT 1 FROM item_field_values fv WHERE fv.item_id = i.id AND fv.field_id = ? AND ${cond})`;
  const c2 = `fv.${x.col(f)}`;
  const nonEmpty = `${c2} IS NOT NULL${x.col(f) === "value_text" ? ` AND ${c2} != ''` : ""}`;
  switch (fl.op) {
    case "not_empty":
      return { sql: has(nonEmpty), args: [f.id] };
    case "empty":
      return { sql: `NOT ${has(nonEmpty)}`, args: [f.id] };
    case "past": // 日付があり、すべて今日より前
      return { sql: `${has(nonEmpty)} AND NOT ${has(`${c2} >= ?`)}`, args: [f.id, f.id, today] };
    case "future": // どれかの日付が条件に当てはまる
    case "until_today":
    case "next_days":
    case "last_days": {
      const c = dateCmp(c2)!;
      return { sql: has(c[0]), args: [f.id, ...c[1]] };
    }
    case "eq":
      return { sql: has(`${c2} = ?`), args: [f.id, fl.value] };
    case "ne":
      return { sql: `NOT ${has(`${c2} = ?`)}`, args: [f.id, fl.value] };
    case "gte":
    case "lte":
      return { sql: has(`${c2} ${fl.op === "gte" ? ">=" : "<="} ?`), args: [f.id, fl.value] };
    case "true":
    case "false":
      return { sql: has(`${c2} = ${fl.op === "true" ? 1 : 0}`), args: [f.id] };
  }
  return null;
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export function notFound(): H {
  return layout("ページが見つかりません", "", html`<main class="wrap"><p class="empty">このページは公開されていないか、存在しません。</p></main>`);
}

function layout(title: string, description: string, body: H): H {
  return html`<!doctype html>
    <html lang="ja">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>${title}</title>
        ${description ? html`<meta name="description" content="${description}" />` : ""}
        <meta property="og:title" content="${title}" />
        ${description ? html`<meta property="og:description" content="${description}" />` : ""}
        <meta property="og:type" content="website" />
        <style>
          ${raw(CSS)}
        </style>
      </head>
      <body>
        ${body}
      </body>
    </html>`;
}

const CSS = `
:root { --bg: #faf8f4; --panel: #ffffff; --text: #1d1b18; --muted: #6e6a62; --line: #e6e1d7; --accent: #8a3b1e; --accent-weak: #f3e7df; color-scheme: light; }
@media (prefers-color-scheme: dark) { :root { --bg: #161513; --panel: #1f1d1a; --text: #eeeae2; --muted: #a39d92; --line: #34312c; --accent: #e3a27f; --accent-weak: #3a2a22; color-scheme: dark; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.7 "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif; -webkit-text-size-adjust: 100%; }
a { color: inherit; }
.wrap { max-width: 860px; margin: 0 auto; padding: 0 16px; }
.hero { border-bottom: 1px solid var(--line); padding: 48px 0 28px; }
.hero h1, .entry-title { word-break: auto-phrase; }
.hero h1 { font-family: "Hiragino Mincho ProN", "Noto Serif JP", serif; font-weight: 600; font-size: clamp(28px, 5vw, 40px); line-height: 1.3; margin: 0 0 12px; letter-spacing: .02em; }
.brand { display: inline-block; margin: 0 0 10px; font-size: 13px; letter-spacing: .08em; color: var(--accent); text-decoration: none; font-weight: 600; }
.preview-bar { background: var(--accent); color: var(--bg); text-align: center; font-size: 13px; padding: 6px 16px; }
.lead { margin: 0 0 12px; font-size: 17px; }
.meta { margin: 0; color: var(--muted); font-size: 13px; }
.tabs { display: flex; gap: 4px; margin: 24px 0 8px; border-bottom: 1px solid var(--line); }
.tabs a { padding: 8px 16px; text-decoration: none; color: var(--muted); border-bottom: 2px solid transparent; margin-bottom: -1px; }
.tabs a.on { color: var(--accent); border-color: var(--accent); font-weight: 600; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin: 16px 0 4px; }
.chips a { text-decoration: none; font-size: 13px; padding: 3px 12px; border: 1px solid var(--line); border-radius: 999px; background: var(--panel); }
.chips a span { color: var(--muted); margin-left: 4px; font-size: 11px; }
.chips a.on { background: var(--accent); border-color: var(--accent); color: var(--bg); }
.chips a.on span { color: inherit; opacity: .8; }
.entries { list-style: none; margin: 8px 0 0; padding: 0; }
.entry { border-bottom: 1px solid var(--line); }
.entry-link { display: flex; gap: 20px; padding: 22px 0; text-decoration: none; align-items: flex-start; }
a.entry-link:hover .entry-title { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
.entry-body { flex: 1; min-width: 0; }
.entry-meta { display: flex; flex-wrap: wrap; gap: 4px 14px; align-items: center; font-size: 13px; color: var(--muted); }
.entry-meta time { font-variant-numeric: tabular-nums; color: var(--text); }
.source { display: inline-flex; align-items: center; gap: 6px; }
.source img { width: 18px; height: 18px; border-radius: 4px; object-fit: cover; }
.entry-title { font-size: 19px; line-height: 1.5; margin: 4px 0 4px; font-weight: 600; overflow-wrap: anywhere; }
.sec-badge { display: inline-block; margin-right: 6px; padding: 1px 8px; border-radius: 999px; background: var(--accent); color: #fff; font-size: 12px; font-weight: 600; line-height: 1.6; vertical-align: 2px; white-space: nowrap; }
.period { margin: 0 0 4px; font-weight: 600; color: var(--accent); font-variant-numeric: tabular-nums; }
.excerpt { margin: 0; color: var(--muted); font-size: 14px; overflow-wrap: anywhere; }
.fields { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 8px 0 0; font-size: 13px; }
.fields div { display: flex; gap: 6px; }
.fields dt { color: var(--muted); }
.fields dd { margin: 0; }
.thumb { width: 168px; aspect-ratio: 16 / 10; object-fit: cover; border-radius: 6px; background: var(--line); flex-shrink: 0; }
.empty { color: var(--muted); padding: 48px 0; text-align: center; }
.pager { display: flex; justify-content: space-between; align-items: center; margin: 24px 0; font-size: 14px; color: var(--muted); }
.pager a { color: var(--accent); text-decoration: none; }
.sources { margin: 48px 0 40px; padding-top: 20px; border-top: 1px solid var(--line); font-size: 13px; color: var(--muted); }
.sources h3 { font-size: 13px; margin: 0 0 6px; }
.sources ul { margin: 0 0 12px; padding-left: 18px; }
.cards { list-style: none; margin: 16px 0 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 20px; }
.card-link { display: flex; flex-direction: column; height: 100%; text-decoration: none; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
a.card-link:hover .entry-title { color: var(--accent); }
.card-img { width: 100%; aspect-ratio: 16 / 10; object-fit: cover; background: var(--line); }
.card-body { padding: 14px 16px 16px; }
.card .entry-title { font-size: 17px; }
.rows { list-style: none; margin: 12px 0 0; padding: 0; }
.row-item { border-bottom: 1px solid var(--line); }
.row-link { display: flex; gap: 14px; align-items: baseline; padding: 10px 0; text-decoration: none; }
a.row-link:hover .row-title { color: var(--accent); text-decoration: underline; text-underline-offset: 3px; }
.row-date { flex-shrink: 0; min-width: 6.5em; font-size: 13px; color: var(--accent); font-variant-numeric: tabular-nums; font-weight: 600; }
.row-date time { color: inherit; }
.row-period { min-width: 13.2em; }
.row-field, .row-excerpt { font-size: 12px; color: var(--muted); }
.row-excerpt { flex: 1 1 12em; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.entries-table .t-excerpt { color: var(--muted); font-size: 13px; min-width: 16em; }
.row-title { flex: 1; min-width: 0; font-weight: 600; overflow-wrap: anywhere; }
.row-source { flex-shrink: 0; font-size: 12px; color: var(--muted); max-width: 30%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.table-wrap { overflow-x: auto; margin: 16px 0 0; }
.entries-table { width: 100%; border-collapse: collapse; font-size: 14px; }
.entries-table th { text-align: left; font-size: 12px; color: var(--muted); font-weight: 600; padding: 8px 10px; border-bottom: 2px solid var(--line); white-space: nowrap; }
.entries-table td { padding: 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
.entries-table .t-title { font-weight: 600; min-width: 16em; }
.entries-table .t-title a { text-decoration: none; }
.entries-table .t-title a:hover { color: var(--accent); text-decoration: underline; }
.entries-table .nowrap { white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--accent); }
.entries-table time { color: inherit; }
@media (max-width: 600px) {
  .row-link { flex-wrap: wrap; gap: 2px 10px; }
  .row-title { flex-basis: 100%; }
  .row-source { max-width: none; }
  .row-date, .row-period { min-width: 0; }
  .entries-table .t-title { min-width: 12em; }
  .hero { padding: 32px 0 20px; }
  .entry-link { gap: 12px; padding: 18px 0; }
  .thumb { width: 96px; }
  .entry-title { font-size: 17px; }
}
`;
