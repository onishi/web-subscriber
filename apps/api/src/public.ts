// セットの公開ページ（認証なし）。本番は PUBLIC_HOST（radar.wagaya.org）の /<slug>、開発時は /p/<slug>
// フィードリーダーではなく「特定カテゴリの新着情報一覧」として、サーバー側で HTML を組み立てて返す。
import { Hono } from "hono";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { type Env, json } from "./env.js";
import { displayValue, loadFields, type SetField } from "./fields.js";

export type PublicLayout = "list" | "cards" | "compact" | "table" | "calendar";
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
  /** 「すべて」タブで、区分の順に見出しを付けてまとめて並べる（区分の中は区分ごとの並び順） */
  group_sections?: boolean;
  /** 絞り込みチップに使う複数値（または テキスト）フィールド */
  facet?: string | null;
  /** 情報源（購読先）ごとの絞り込みボタンを出す */
  source_filter?: boolean;
  layout?: PublicLayout;
  /** ページの幅：normal（860px）/ wide（1200px）/ full（画面いっぱい・最大 1600px） */
  width?: PublicWidth;
  /** 色調（THEMES のキー） */
  theme?: PublicTheme;
  /** 明暗：auto（端末の設定に合わせる）/ light / dark */
  color_mode?: ColorMode;
  /** カレンダー表示でマスに置く日付：published（日付）または f:<日付フィールドのキー> */
  calendar_key?: string;
  /**
   * 表示する項目とその順番。date / source / title / period / excerpt / f:<フィールドのキー>。
   * 未指定なら show と fields から組み立てる（以前の設定との互換）
   */
  display?: string[];
  /** 標準項目の表示（未指定は表示）。display があるときは image だけを使う */
  show?: { date?: boolean; source?: boolean; period?: boolean; excerpt?: boolean; image?: boolean };
  excerpt_length?: number;
  per_page?: number;
  /** タブ・区分ごとの並び順（区分の id または all） */
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
export type PublicWidth = "normal" | "wide" | "full";
export type ColorMode = "auto" | "light" | "dark";
type Palette = { bg: string; panel: string; text: string; muted: string; line: string; accent: string; "accent-weak": string };
/** 公開ページの色調（和の伝統色）：明るい配色と暗い配色の組。キーは保存値なので変えない */
export const THEMES = {
  warm: { label: "弁柄", light: { bg: "#faf8f4", panel: "#ffffff", text: "#1d1b18", muted: "#6e6a62", line: "#e6e1d7", accent: "#8a3b1e", "accent-weak": "#f3e7df" }, dark: { bg: "#161513", panel: "#1f1d1a", text: "#eeeae2", muted: "#a39d92", line: "#34312c", accent: "#e3a27f", "accent-weak": "#3a2a22" } },
  akane: { label: "茜", light: { bg: "#fbf6f5", panel: "#ffffff", text: "#2a1a19", muted: "#776261", line: "#efdedb", accent: "#b0262c", "accent-weak": "#f7e1df" }, dark: { bg: "#1a1111", panel: "#231818", text: "#f3e5e4", muted: "#b49a98", line: "#3b2828", accent: "#f08a85", "accent-weak": "#45201f" } },
  sakura: { label: "桜", light: { bg: "#fcf7f8", panel: "#ffffff", text: "#2a1c20", muted: "#7a6469", line: "#f0dfe3", accent: "#b0466a", "accent-weak": "#f8e4ea" }, dark: { bg: "#1a1215", panel: "#23191c", text: "#f2e6e9", muted: "#b39aa1", line: "#3a2a2f", accent: "#f29bb8", "accent-weak": "#43242f" } },
  yamabuki: { label: "山吹", light: { bg: "#fbf8ef", panel: "#ffffff", text: "#231d10", muted: "#6f6650", line: "#ece4cf", accent: "#9a6a00", "accent-weak": "#f6ebcc" }, dark: { bg: "#17140c", panel: "#201c12", text: "#f0e9d8", muted: "#a89e86", line: "#362f20", accent: "#f0c048", "accent-weak": "#3a2f12" } },
  uguisu: { label: "鶯", light: { bg: "#f7f7f0", panel: "#ffffff", text: "#1f2015", muted: "#66675a", line: "#e3e3d3", accent: "#6a6a1f", "accent-weak": "#ececd6" }, dark: { bg: "#13140e", panel: "#1b1c14", text: "#ebebdd", muted: "#a2a38f", line: "#2f3023", accent: "#c9c870", "accent-weak": "#2c2d17" } },
  forest: { label: "千歳緑", light: { bg: "#f5f8f3", panel: "#ffffff", text: "#18221a", muted: "#5f6f60", line: "#dde6da", accent: "#2f6b3a", "accent-weak": "#e2efe2" }, dark: { bg: "#101611", panel: "#182019", text: "#e6eee5", muted: "#9bab9b", line: "#2b372c", accent: "#8fd19a", "accent-weak": "#1f3523" } },
  ocean: { label: "浅葱", light: { bg: "#f3f8f9", panel: "#ffffff", text: "#13232a", muted: "#5a6f77", line: "#d9e6ea", accent: "#0f6f86", "accent-weak": "#dff0f4" }, dark: { bg: "#0e1619", panel: "#152024", text: "#e3eef1", muted: "#93a9b0", line: "#263538", accent: "#7fd0e2", "accent-weak": "#183740" } },
  indigo: { label: "藍", light: { bg: "#f5f7fb", panel: "#ffffff", text: "#172033", muted: "#5f6b80", line: "#dde3ee", accent: "#2f4a9e", "accent-weak": "#e4eaf8" }, dark: { bg: "#0f1420", panel: "#171d2b", text: "#e6ebf5", muted: "#9aa5ba", line: "#2a3346", accent: "#9db4f5", "accent-weak": "#22305a" } },
  fuji: { label: "藤", light: { bg: "#f8f6fb", panel: "#ffffff", text: "#221c2e", muted: "#6a6278", line: "#e6e0ef", accent: "#6c4a9e", "accent-weak": "#ece4f6" }, dark: { bg: "#15121b", panel: "#1d1925", text: "#ece7f4", muted: "#a59db3", line: "#322b3d", accent: "#c3a6ec", "accent-weak": "#2f2442" } },
  ink: { label: "墨", light: { bg: "#f7f7f5", panel: "#ffffff", text: "#1a1a1a", muted: "#6b6b6b", line: "#e2e2df", accent: "#1a1a1a", "accent-weak": "#ececea" }, dark: { bg: "#121212", panel: "#1c1c1c", text: "#ededed", muted: "#9a9a9a", line: "#2e2e2e", accent: "#f0f0f0", "accent-weak": "#2a2a2a" } },
} satisfies Record<string, { label: string; light: Palette; dark: Palette }>;
export type PublicTheme = keyof typeof THEMES;
const COLOR_MODES: ColorMode[] = ["auto", "light", "dark"];

/** 色調・明暗から :root の色の定義を作る */
function themeCss(theme: PublicTheme = "warm", mode: ColorMode = "auto"): string {
  const t = THEMES[theme] ?? THEMES.warm;
  const vars = (p: Palette, scheme: string) => `:root { ${Object.entries(p).map(([k, v]) => `--${k}: ${v};`).join(" ")} color-scheme: ${scheme}; }`;
  if (mode === "light") return vars(t.light, "light");
  if (mode === "dark") return vars(t.dark, "dark");
  return `${vars(t.light, "light")}\n@media (prefers-color-scheme: dark) { ${vars(t.dark, "dark")} }`;
}
const WIDTHS: PublicWidth[] = ["normal", "wide", "full"];
export const LAYOUTS: PublicLayout[] = ["list", "cards", "compact", "table", "calendar"];
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
export function normalizePublicOptions(
  o: PublicOptions | null | undefined,
  fields: SetField[],
): Required<Omit<PublicOptions, "period" | "facet" | "calendar_key">> & Pick<PublicOptions, "period" | "facet"> & { calendar_key: string } {
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
  const group_sections = !!o.group_sections && sections.some((x) => !x.hidden);
  const sort: Record<string, PublicSort> = {};
  // タブのほか、見出しでまとめるときは各区分の中の並び順も持つ
  for (const t of [...new Set([...tabs, ...(group_sections ? sections.filter((x) => !x.hidden).map((x) => x.id) : [])])]) {
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
    width: WIDTHS.includes(o.width as PublicWidth) ? (o.width as PublicWidth) : "normal",
    theme: (typeof o.theme === "string" && o.theme in THEMES ? o.theme : "warm") as PublicTheme,
    color_mode: COLOR_MODES.includes(o.color_mode as ColorMode) ? (o.color_mode as ColorMode) : "auto",
    source_filter: !!o.source_filter,
    // 未指定なら期間の開始、なければ日付
    calendar_key:
      typeof o.calendar_key === "string" && (o.calendar_key === "published" || (o.calendar_key.startsWith("f:") && keys.get(o.calendar_key.slice(2))?.type === "date"))
        ? o.calendar_key
        : period
          ? `f:${period.start}`
          : "published",
    show: { date: display.includes("date"), source: display.includes("source"), period: display.includes("period"), excerpt: display.includes("excerpt"), image: show.image !== false },
    excerpt_length: clampInt(o.excerpt_length, 20, 400, 140),
    per_page: clampInt(o.per_page, 10, 100, 30),
    sort,
    sections,
    all_tab: tabs.includes("all"),
    group_sections,
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

/**
 * 公開ページの Atom フィード（/<slug>/feed.xml）。公開日（なければ見つけた日）の新しい順に 50 件。
 * 見つけた順にすると、購読を追加したときに過去分（フィードの古い記事など）がまとめて先頭に並ぶため
 * 公開ページと同じ絞り込み条件・区分に従い、?tab=<区分> でその区分だけにできる
 */
publicPages.get("/:slug/feed.xml", async (c) => {
  const slug = c.req.param("slug");
  const st = await c.env.DB.prepare("SELECT * FROM sets WHERE public_slug = ?").bind(slug).first<Record<string, string | number | null>>();
  const token = c.req.query("token") ?? "";
  if (!st || (!st.is_public && !(typeof st.public_preview_token === "string" && token && safeEqual(token, st.public_preview_token)))) return c.text("not found", 404);
  const fields = await loadFields(c.env, st.id as string);
  const opts = normalizePublicOptions(json<PublicOptions>(st.public_options_json as string | null, {}), fields);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const qTab = c.req.query("tab") ?? "";
  const tab = opts.sections.some((x) => x.id === qTab) ? qTab : "all";
  const { where, args } = scopeSql(st.id as string, opts, byKey, jstToday(), tab);
  const rs = await c.env.DB.prepare(
    `SELECT i.id, i.subscription_id, i.title_text, i.primary_link, i.first_seen_at, i.last_changed_at,
       ${IMAGE} AS image, ${SUMMARY} AS summary,
       COALESCE(json_extract(i.detail_json, '$.published_at.value'), json_extract(i.data_json, '$.published_at.value')) AS published,
       (SELECT COALESCE(s.display_title, s.input_url) FROM subscriptions s WHERE s.id = i.subscription_id) AS source
     FROM items i WHERE ${where.join(" AND ")} ORDER BY COALESCE(i.published_sort, i.first_seen_at) DESC, i.id DESC LIMIT 50`,
  )
    .bind(...args)
    .all<{ id: string; subscription_id: string; title_text: string | null; primary_link: string | null; first_seen_at: string; last_changed_at: string | null; image: string | null; summary: string | null; published: string | null; source: string | null }>();
  const items = rs.results;
  // 公開ページに出しているカスタムフィールド（期間を含む）を本文に添える
  const shown = [...new Set([...opts.fields, ...(opts.period ? [opts.period.start, opts.period.end] : [])])].map((k) => byKey.get(k)).filter((f): f is SetField => !!f);
  const values = new Map<string, { label: string; text: string }[]>();
  if (items.length && shown.length) {
    const vr = await c.env.DB.prepare(
      `SELECT item_id, field_id, value_text, value_num, value_date FROM item_field_values WHERE item_id IN (${items.map(() => "?").join(",")}) AND field_id IN (${shown.map(() => "?").join(",")}) ORDER BY ord`,
    )
      .bind(...items.map((i) => i.id), ...shown.map((f) => f.id))
      .all<{ item_id: string; field_id: string; value_text: string | null; value_num: number | null; value_date: string | null }>();
    const by = new Map<string, Map<string, string[]>>();
    for (const r of vr.results) {
      const m = by.get(r.item_id) ?? new Map<string, string[]>();
      const f = shown.find((x) => x.id === r.field_id)!;
      const d = displayValue(f.type, r);
      m.set(f.id, [...(m.get(f.id) ?? []), f.type === "date" ? fmtDate(String(d)) : f.type === "boolean" ? (d ? "はい" : "いいえ") : String(d)]);
      by.set(r.item_id, m);
    }
    for (const [id, m] of by) values.set(id, shown.filter((f) => m.has(f.id)).map((f) => ({ label: f.label, text: m.get(f.id)!.join("・") })));
  }
  const url = new URL(c.req.url);
  const pageUrl = `${url.origin}${url.pathname.replace(/\/feed\.xml$/, "")}${tab !== "all" ? `?tab=${encodeURIComponent(tab)}` : ""}`;
  const title = ((st.public_title as string) || (st.name as string)) + (tab !== "all" ? `（${opts.sections.find((x) => x.id === tab)?.label ?? tab}）` : "");
  const x = (v: string) => v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const iso = (v: string) => new Date(Date.parse(v)).toISOString();
  const updated = items.reduce((m, i) => (i.first_seen_at > m ? i.first_seen_at : m), (st.updated_at as string) ?? new Date().toISOString());
  const entries = items.map((i) => {
    const link = safeUrl(i.primary_link);
    const img = safeUrl(i.image);
    const sum = excerpt(i.summary, 300);
    const vals = values.get(i.id) ?? [];
    const body = [
      img ? `<p><img src="${x(img)}" alt="" /></p>` : "",
      vals.length ? `<dl>${vals.map((v) => `<dt>${x(v.label)}</dt><dd>${x(v.text)}</dd>`).join("")}</dl>` : "",
      sum ? `<p>${x(sum)}</p>` : "",
      i.source ? `<p>情報源：${x(i.source)}</p>` : "",
    ].join("");
    const pub = i.published && !Number.isNaN(Date.parse(i.published)) ? iso(i.published) : null;
    return `<entry>
<id>tag:${x(url.hostname)},2026:item:${i.id}</id>
<title>${x(i.title_text ?? i.primary_link ?? "")}</title>
${link ? `<link rel="alternate" href="${x(link)}" />` : ""}
${pub ? `<published>${pub}</published>` : ""}
<updated>${iso(i.last_changed_at ?? i.first_seen_at)}</updated>
${i.source ? `<author><name>${x(i.source)}</name></author>` : ""}
${sum ? `<summary>${x(sum)}</summary>` : ""}
<content type="html">${x(body)}</content>
</entry>`;
  });
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="ja">
<id>tag:${x(url.hostname)},2026:set:${x(slug)}${tab !== "all" ? `:${x(tab)}` : ""}</id>
<title>${x(title)}</title>
${st.public_description ? `<subtitle>${x(String(st.public_description))}</subtitle>` : ""}
<link rel="self" type="application/atom+xml" href="${x(c.req.url)}" />
<link rel="alternate" type="text/html" href="${x(pageUrl)}" />
<updated>${iso(updated)}</updated>
<generator>radar</generator>
${entries.join("\n")}
</feed>`;
  c.header("Cache-Control", "public, max-age=600");
  return c.body(xml, 200, { "Content-Type": "application/atom+xml; charset=utf-8" });
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

  const col = (f: SetField) => (f.type === "date" ? "value_date" : f.type === "number" || f.type === "boolean" ? "value_num" : "value_text");
  const v = (f: SetField, agg: "MIN" | "MAX") => `(SELECT ${agg}(${col(f)}) FROM item_field_values WHERE item_id = i.id AND field_id = '${f.id.replace(/[^0-9A-Za-z]/g, "")}')`;
  const { where, args, secSql, secArgs } = scopeSql(st.id as string, opts, byKey, today, tab);
  // 並び順：値のないものは常に後ろ
  const sortSql = (sort: PublicSort) => {
  const agg = sort.dir === "asc" ? "MIN" : "MAX";
  return (
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
              : "COALESCE(i.published_sort, i.first_seen_at)"
  );
  };
  const sortOrder = (sort: PublicSort, when?: string) => {
    const e = sortSql(sort);
    const w = (x: string) => (when ? `(CASE WHEN ${when} THEN ${x} END)` : x);
    return `${w(`(${e}) IS NULL`)}, ${w(e)} ${sort.dir === "asc" ? "ASC" : "DESC"}`;
  };
  // 見出しでまとめるとき：区分の順に並べ、区分の中はそれぞれの並び順（sec は SELECT の別名）
  const grouped = opts.group_sections && tab === "all" && !!secSql;
  const order = `${
    grouped
      ? ["sec", ...sections.map((x, k) => (x.hidden ? null : sortOrder(opts.sort[x.id] ?? DEFAULT_SORT.all, `sec = ${k}`))).filter(Boolean), sortOrder(opts.sort.all ?? DEFAULT_SORT.all, `sec = ${sections.length}`)].join(", ")
      : sortOrder(opts.sort[tab] ?? DEFAULT_SORT.all)
  }, COALESCE(i.published_sort, i.first_seen_at) DESC, i.id DESC`;
  if (facet && facetValue) {
    where.push("EXISTS (SELECT 1 FROM item_field_values fv WHERE fv.item_id = i.id AND fv.field_id = ? AND fv.value_text = ?)");
    args.push(facet.id, facetValue);
  }
  // 情報源での絞り込み（?src=<購読先の id>）。件数は情報源を絞る前の条件で数える
  const srcValue = opts.source_filter && /^[0-9A-Z]{26}$/.test(c.req.query("src") ?? "") ? c.req.query("src")! : "";
  const srcCountQuery = opts.source_filter
    ? c.env.DB.prepare(`SELECT i.subscription_id AS id, COUNT(*) AS count FROM items i WHERE ${where.join(" AND ")} GROUP BY i.subscription_id`)
        .bind(...args)
        .all<{ id: string; count: number }>()
    : null;
  if (srcValue) {
    where.push("i.subscription_id = ?");
    args.push(srcValue);
  }
  // カレンダー：表示する月（?month=YYYY-MM、既定は今月）と、その月に日付がある item
  const calendar = kind === "calendar";
  const qMonth = c.req.query("month") ?? "";
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(qMonth) && qMonth >= "1970-01" && qMonth <= "2999-12" ? qMonth : today.slice(0, 7);
  const calKey = opts.calendar_key;
  const calField = calKey.startsWith("f:") ? byKey.get(calKey.slice(2)) : undefined;
  const calendarQuery = () => {
    const from = `${month}-01`;
    const to = `${month}-31`;
    // 日まで分かる日付だけを使う（YYYY-MM / YYYY は置けない）
    const [dateExpr, join, joinArgs] = calField
      ? ["fv.value_date", "JOIN item_field_values fv ON fv.item_id = i.id AND fv.field_id = ? AND length(fv.value_date) = 10", [calField.id]]
      : ["date(i.published_sort, '+9 hours')", "", []];
    return c.env.DB.prepare(
      `SELECT DISTINCT i.id, i.subscription_id, i.title_text, i.primary_link, ${dateExpr} AS d, ${secSql || "NULL"} AS sec
       FROM items i ${join} WHERE ${where.join(" AND ")} AND ${dateExpr} BETWEEN ? AND ?
       ORDER BY d, sec, TRIM(i.title_text, char(32, 9, 10, 13, 12288)), i.id LIMIT 1000`,
    )
      .bind(...(secSql ? secArgs : []), ...joinArgs, ...args, from, to)
      .all<{ id: string; subscription_id: string; title_text: string | null; primary_link: string | null; d: string; sec: number | null }>();
  };
  // DB との往復を減らすため、互いに依存しない問い合わせはまとめて投げる
  const [rs, sources, chipRows, calRows, srcCounts] = await Promise.all([
    c.env.DB.prepare(
    `SELECT i.id, i.subscription_id, i.title_text, i.primary_link, i.first_seen_at, i.last_changed_at,
       ${IMAGE} AS image,
       ${SUMMARY} AS summary,
       json_extract(i.data_json, '$.summary.value') AS summary_list,
       COALESCE(json_extract(i.detail_json, '$.content.value'), json_extract(i.data_json, '$.content.value')) AS content,
       COALESCE(json_extract(i.detail_json, '$.published_at.value'), json_extract(i.data_json, '$.published_at.value')) AS published,
       ${secSql || "NULL"} AS sec
     FROM items i WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`,
  )
    .bind(...(secSql ? secArgs : []), ...args, PER_PAGE + 1, calendar ? 0 : (page - 1) * PER_PAGE)
    .all<{ id: string; subscription_id: string; title_text: string | null; primary_link: string | null; first_seen_at: string; last_changed_at: string | null; image: string | null; summary: string | null; summary_list: string | null; content: string | null; published: string | null; sec: number | null }>(),
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
    calendar ? calendarQuery() : null,
    srcCountQuery,
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
    const all = { token: preview ? token : undefined, tab: tabs.length > 1 ? tab : undefined, v: facetValue || undefined, src: srcValue || undefined, month: calendar && month !== today.slice(0, 7) ? month : undefined, ...o };
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
      // 区切り線（「——」など）だけの概要は飛ばし、一覧の概要・本文を使う
      ex: show.excerpt ? excerpt([it.summary, it.summary_list, it.content].find((x) => !!x && /[\p{L}\p{N}]/u.test(stripTags(x))) ?? null, opts.excerpt_length) : null,
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
        // 画像がない（または読み込めない）ときも同じ大きさの枠に情報源の名前を出して、カードの高さをそろえる
        html`${show.image
          ? html`<div class="card-media">
              <span class="card-noimg">${x.s?.title ?? ""}</span>
              ${x.img ? html`<img class="card-img" src="${x.img}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />` : ""}
            </div>`
          : ""}
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
  const table = (rows: typeof items) => html`<div class="table-wrap">
    <table class="entries-table">
      <thead>
        <tr>
          ${opts.display.map((k) => html`<th>${fieldOf(k)?.label ?? COL_LABEL[k] ?? ""}</th>`)}
        </tr>
      </thead>
      <tbody>
        ${rows.map((it) => {
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

  /** 月のカレンダー（日曜始まり）。狭い画面では item のある日だけの一覧になる */
  const calendarEl = () => {
    const byDay = new Map<string, NonNullable<typeof calRows>["results"]>();
    for (const r of calRows?.results ?? []) byDay.set(r.d, [...(byDay.get(r.d) ?? []), r]);
    const [y, m] = month.split("-").map(Number);
    const first = new Date(Date.UTC(y, m - 1, 1));
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const lead = first.getUTCDay();
    const shift = (n: number) => {
      const d = new Date(Date.UTC(y, m - 1 + n, 1));
      return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    };
    const cells: (number | null)[] = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
    while (cells.length % 7) cells.push(null);
    const WD = ["日", "月", "火", "水", "木", "金", "土"];
    const ev = (r: NonNullable<typeof calRows>["results"][number]) => {
      const sec = r.sec != null ? sections[r.sec] : undefined;
      const s = src.get(r.subscription_id);
      const body = html`${sec?.badge ? html`<span class="sec-badge">${sec.label}</span>` : ""}${r.title_text ?? r.primary_link}`;
      const link = safeUrl(r.primary_link);
      return html`<li class="cal-ev" title="${s?.title ?? ""}">${link ? html`<a href="${link}" target="_blank" rel="noopener">${body}</a>` : body}</li>`;
    };
    return html`<div class="cal">
      <nav class="cal-nav">
        <a href="${q({ month: shift(-1), page: undefined })}" data-kb="prev">← 前の月</a>
        <h2>${y}年${m}月</h2>
        <a href="${q({ month: shift(1), page: undefined })}" data-kb="next">次の月 →</a>
      </nav>
      ${month !== today.slice(0, 7) ? html`<p class="cal-today"><a href="${q({ month: today.slice(0, 7) })}" data-kb="today">今月へ</a></p>` : ""}
      <div class="cal-grid" role="table" aria-label="${y}年${m}月">
        ${WD.map((w, i) => html`<div class="cal-wd${i === 0 ? " sun" : i === 6 ? " sat" : ""}" role="columnheader">${w}</div>`)}
        ${cells.map((d, i) => {
          if (!d) return html`<div class="cal-day out" aria-hidden="true"></div>`;
          const key = `${month}-${String(d).padStart(2, "0")}`;
          const evs = byDay.get(key) ?? [];
          const wd = i % 7;
          return html`<div class="cal-day${evs.length ? " has" : " none"}${key === today ? " today" : ""}${wd === 0 ? " sun" : wd === 6 ? " sat" : ""}" role="cell">
            <div class="cal-date"><span class="cal-d">${d}</span><span class="cal-w">（${WD[wd]}）</span></div>
            ${evs.length ? html`<ul>${evs.map(ev)}</ul>` : ""}
          </div>`;
        })}
      </div>
      ${(calRows?.results.length ?? 0) === 0 ? html`<p class="empty">この月に日付のある情報はありません。</p>` : ""}
    </div>`;
  };
  const listOf = (xs: typeof items) =>
    kind === "table" ? table(xs) : kind === "cards" ? html`<ol class="cards">${xs.map(entry)}</ol>` : kind === "compact" ? html`<ol class="rows">${xs.map(entry)}</ol>` : html`<ol class="entries">${xs.map(entry)}</ol>`;
  // 見出しでまとめるときは、続いて並ぶ同じ区分ごとに見出しを付ける
  const listEl = () => {
    if (!grouped) return listOf(items);
    const groups: { sec: number; xs: typeof items }[] = [];
    for (const it of items) {
      const k = it.sec ?? sections.length;
      if (groups.length && groups[groups.length - 1].sec === k) groups[groups.length - 1].xs.push(it);
      else groups.push({ sec: k, xs: [it] });
    }
    return groups.map((g) => html`<section class="sec-group"><h2 class="sec-heading">${sections[g.sec]?.label ?? "その他"}</h2>${listOf(g.xs)}</section>`);
  };

  c.header("Cache-Control", "public, max-age=300");
  if (preview) {
    // トークンが外部サイトへの Referer や共有キャッシュに漏れないように
    c.header("Cache-Control", "private, no-store");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Robots-Tag", "noindex, nofollow");
  }
  const feedHref = `./${slug}/feed.xml${preview ? `?token=${encodeURIComponent(token)}` : ""}`;
  return c.html(
    layout(
      title,
      description,
      html`
        ${preview ? html`<div class="preview-bar">プレビュー：このページは非公開です。この URL を知っている人だけが見られます。</div>` : ""}
        <header class="hero">
          <div class="wrap w-${opts.width}">
            <a class="brand" href="./">radar</a>
            <h1>${title}</h1>
            ${description ? html`<p class="lead">${description}</p>` : ""}
            <p class="meta">${sources.results.length} の情報源から自動で収集${updated ? html`・最終更新 ${fmtJst(updated)}` : ""}</p>
          </div>
        </header>
        <main class="wrap w-${opts.width}">
          ${tabs.length > 1
            ? html`<nav class="tabs" aria-label="区分">
                ${tabs.map((t) => html`<a href="${q({ tab: t.id, page: 1 })}" data-kb-tab class="${tab === t.id ? "on" : ""}" ${tab === t.id ? raw('aria-current="page"') : ""}>${t.label}</a>`)}
              </nav>`
            : ""}
          ${srcCounts
            ? (() => {
                const n = new Map(srcCounts.results.map((r) => [r.id, r.count]));
                const xs = sources.results.filter((x) => (n.get(x.id) ?? 0) > 0 || x.id === srcValue);
                return xs.length > 1 || srcValue
                  ? html`<nav class="chips src-chips" aria-label="情報源">
                      <a href="${q({ src: undefined, page: 1 })}" class="${srcValue ? "" : "on"}">すべての情報源</a>
                      ${xs.map((x) => html`<a href="${q({ src: x.id, page: 1 })}" class="${srcValue === x.id ? "on" : ""}">${x.title}<span>${n.get(x.id) ?? 0}</span></a>`)}
                    </nav>`
                  : "";
              })()
            : ""}
          ${chips.length
            ? html`<nav class="chips" aria-label="${facet!.label}">
                <a href="${q({ v: undefined, page: 1 })}" class="${facetValue ? "" : "on"}">すべて</a>
                ${chips.map((ch) => html`<a href="${q({ v: ch.value, page: 1 })}" class="${facetValue === ch.value ? "on" : ""}">${ch.value}<span>${ch.count}</span></a>`)}
              </nav>`
            : ""}
          ${calendar ? calendarEl() : items.length ? listEl() : html`<p class="empty">${tab === "all" ? "まだ情報がありません。" : `「${tabs.find((t) => t.id === tab)?.label ?? ""}」に当てはまる情報はありません。`}</p>`}
          ${!calendar && (page > 1 || rs.results.length > PER_PAGE)
            ? html`<nav class="pager">
                ${page > 1 ? html`<a href="${q({ page: page - 1 })}" data-kb="prev">← 前へ</a>` : html`<span></span>`}
                <span>${page} ページ</span>
                ${rs.results.length > PER_PAGE ? html`<a href="${q({ page: page + 1 })}" data-kb="next">次へ →</a>` : html`<span></span>`}
              </nav>`
            : ""}
          <footer class="sources">
            <h3>情報源</h3>
            <ul>
              ${sources.results.map((s) => html`<li><a href="${safeUrl(s.home) ?? safeUrl(s.input_url) ?? "#"}" target="_blank" rel="noopener">${s.title}</a></li>`)}
            </ul>
            <p>各情報の内容は情報源のサイトでご確認ください。このページは各サイトの公開情報を自動で収集・整理しています。</p>
            <p class="feed-link"><a href="${feedHref}">フィード（Atom）</a>：新しく見つけた情報をフィードリーダーで受け取れます</p>
            <p class="kb-hint"><a href="#" data-kb-help>キーボードショートカット（?）</a></p>
          </footer>
        </main>
      `,
      feedHref,
      { theme: opts.theme, mode: opts.color_mode },
    ),
  );
});

// 画像：配信元の指定 → 詳細ページの取得ルールで取った画像（設定で指定したもの）→ リンク先の og:image・本文の画像
const IMAGE = "COALESCE(CASE WHEN i.image_source = 'feed' THEN i.image_url END, json_extract(i.detail_json, '$.native.extracted_fields.image'), i.image_url)";
const SUMMARY =
  "COALESCE(json_extract(i.detail_json, '$.summary.value'), json_extract(i.data_json, '$.summary.value'), json_extract(i.detail_json, '$.content.value'), json_extract(i.data_json, '$.content.value'))";

/** セットの公開ページに出す item の条件（情報源・絞り込み条件・区分）。tab が区分ならその区分だけ、それ以外は非表示の区分を除く */
function scopeSql(setId: string, opts: ReturnType<typeof normalizePublicOptions>, byKey: Map<string, SetField>, today: string, tab: string) {
  const sections = opts.sections;
  const where = ["i.subscription_id IN (SELECT m.subscription_id FROM set_members m JOIN subscriptions s ON s.id = m.subscription_id WHERE m.set_id = ? AND s.status != 'archived')", "(i.title_text IS NOT NULL OR i.primary_link IS NOT NULL)"];
  const args: unknown[] = [setId];
  const col = (f: SetField) => (f.type === "date" ? "value_date" : f.type === "number" || f.type === "boolean" ? "value_num" : "value_text");
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
  return { where, args, secSql, secArgs };
}

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

function layout(title: string, description: string, body: H, feedUrl?: string, theme?: { theme: PublicTheme; mode: ColorMode }): H {
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
        ${feedUrl ? html`<link rel="alternate" type="application/atom+xml" title="${title}" href="${feedUrl}" />` : ""}
        <meta name="theme-color" content="${THEMES[theme?.theme ?? "warm"][theme?.mode === "dark" ? "dark" : "light"].bg}" />
        <style>
          ${raw(themeCss(theme?.theme, theme?.mode))}
          ${raw(CSS)}
        </style>
      </head>
      <body>
        ${body}
        <script>
          ${raw(KEYS_JS)}
        </script>
      </body>
    </html>`;
}

/** キーボードショートカット（j/k で移動、o/Enter で開く、h/l でページ・月、1-9 でタブ、? でヘルプ） */
const KEYS_JS = `(() => {
  const SEL = "li.entry, li.card, li.row-item, .entries-table tbody tr, .cal-ev";
  let cur = -1;
  const list = () => [...document.querySelectorAll(SEL)].filter((el) => el.offsetParent !== null);
  const linkOf = (el) => el && (el.matches("a[href]") ? el : el.querySelector("a[href]"));
  const select = (i) => {
    const xs = list();
    if (!xs.length) return;
    cur = Math.max(0, Math.min(xs.length - 1, i));
    xs.forEach((el, j) => el.classList.toggle("kb-cur", j === cur));
    xs[cur].scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  const go = (sel) => { const a = document.querySelector(sel); if (a) location.href = a.href; };
  let help = null;
  const toggleHelp = (show) => {
    if (!help) {
      help = document.createElement("div");
      help.className = "kb-help";
      help.setAttribute("role", "dialog");
      help.setAttribute("aria-label", "キーボードショートカット");
      const rows = [["j / k", "次 / 前の情報"], ["o / Enter", "選んだ情報を新しいタブで開く"], ["h / l（← / →）", "前 / 次のページ（カレンダーは月）"], ["t", "今月へ（カレンダー）"], ["1〜9", "タブを切り替える"], ["?", "このヘルプ"], ["Esc", "閉じる・選択を外す"]];
      help.innerHTML = '<div class="kb-box"><h2>キーボードショートカット</h2><dl>' + rows.map((r) => "<dt><kbd>" + r[0] + "</kbd></dt><dd>" + r[1] + "</dd>").join("") + '</dl><button type="button">閉じる</button></div>';
      help.addEventListener("click", (e) => { if (e.target === help || e.target.tagName === "BUTTON") toggleHelp(false); });
      document.body.appendChild(help);
    }
    help.hidden = !(show ?? help.hidden);
  };
  document.addEventListener("click", (e) => { const a = e.target.closest && e.target.closest("[data-kb-help]"); if (a) { e.preventDefault(); toggleHelp(true); } });
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (help && !help.hidden) { if (e.key === "Escape" || e.key === "?") { toggleHelp(false); e.preventDefault(); } return; }
    const k = e.key;
    if (k === "j") select(cur + 1);
    else if (k === "k") select(cur < 0 ? 0 : cur - 1);
    else if (k === "o" || (k === "Enter" && cur >= 0 && t === document.body)) {
      const a = linkOf(list()[cur]);
      if (!a) return;
      window.open(a.href, "_blank", "noopener");
    } else if (k === "h" || k === "ArrowLeft") go('[data-kb="prev"]');
    else if (k === "l" || k === "ArrowRight") go('[data-kb="next"]');
    else if (k === "t") go('[data-kb="today"]');
    else if (/^[1-9]$/.test(k)) { const a = document.querySelectorAll("[data-kb-tab]")[Number(k) - 1]; if (a) location.href = a.href; else return; }
    else if (k === "?") toggleHelp(true);
    else if (k === "Escape") { cur = -1; list().forEach((el) => el.classList.remove("kb-cur")); }
    else return;
    e.preventDefault();
  });
})();`;

const CSS = `
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.7 "Hiragino Sans", "Noto Sans JP", system-ui, sans-serif; -webkit-text-size-adjust: 100%; }
a { color: inherit; }
.wrap { max-width: 860px; margin: 0 auto; padding: 0 16px; }
.wrap.w-wide { max-width: 1200px; }
.wrap.w-full { max-width: 1600px; padding: 0 24px; }
@media (max-width: 600px) { .wrap.w-full { padding: 0 16px; } }
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
.sec-group + .sec-group { margin-top: 32px; }
.sec-heading { margin: 24px 0 4px; font-size: 18px; font-weight: 700; padding-bottom: 6px; border-bottom: 2px solid var(--accent); display: inline-block; }
.sec-badge { display: inline-block; margin-right: 6px; padding: 1px 8px; border-radius: 999px; background: var(--accent); color: var(--bg); font-size: 12px; font-weight: 600; line-height: 1.6; vertical-align: 2px; white-space: nowrap; }
.period { margin: 0 0 4px; font-weight: 600; color: var(--accent); font-variant-numeric: tabular-nums; }
.excerpt { margin: 0; color: var(--muted); font-size: 14px; overflow-wrap: anywhere; }
.fields { display: flex; flex-wrap: wrap; gap: 4px 16px; margin: 8px 0 0; font-size: 13px; }
.fields div { display: flex; gap: 6px; }
.fields dt { color: var(--muted); }
.fields dd { margin: 0; }
.thumb { width: 168px; aspect-ratio: 16 / 10; object-fit: cover; border-radius: 6px; background: var(--line); flex-shrink: 0; }
.empty { color: var(--muted); padding: 48px 0; text-align: center; }
.cal { margin-top: 16px; }
.cal-nav { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.cal-nav h2 { margin: 0; font-size: 20px; }
.cal-nav a, .cal-today a { color: var(--accent); text-decoration: none; font-size: 14px; }
.cal-today { margin: 4px 0 0; text-align: center; }
.cal-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); margin-top: 12px; border-top: 1px solid var(--line); border-left: 1px solid var(--line); }
.cal-wd { padding: 6px; font-size: 12px; text-align: center; color: var(--muted); border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); background: var(--panel); }
.cal-day { min-height: 96px; padding: 4px 6px 6px; border-right: 1px solid var(--line); border-bottom: 1px solid var(--line); background: var(--panel); min-width: 0; }
.cal-day.out { background: transparent; }
.cal-date { font-size: 13px; font-variant-numeric: tabular-nums; color: var(--muted); }
.cal-w { display: none; }
.sun .cal-d, .cal-wd.sun { color: #c0392b; }
.sat .cal-d, .cal-wd.sat { color: #2c6fb7; }
.cal-day.today { box-shadow: inset 0 0 0 2px var(--accent); }
.cal-day.today .cal-d { font-weight: 700; color: var(--accent); }
.cal-day ul { list-style: none; margin: 4px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.cal-ev { font-size: 12px; line-height: 1.4; overflow-wrap: anywhere; }
.cal-ev a { color: var(--text); text-decoration: none; display: block; padding: 2px 4px; border-radius: 4px; background: var(--accent-weak); }
.cal-ev a:hover { text-decoration: underline; }
.cal-ev .sec-badge { font-size: 10px; padding: 0 5px; margin-right: 4px; }
@media (max-width: 640px) {
  .cal-grid { display: block; border: 0; }
  .cal-wd, .cal-day.out, .cal-day.none { display: none; }
  .cal-day { min-height: 0; border: 0; border-bottom: 1px solid var(--line); padding: 10px 0; background: transparent; display: flex; gap: 12px; }
  .cal-day.today { box-shadow: none; }
  .cal-date { flex: 0 0 4.5em; font-size: 15px; }
  .cal-w { display: inline; font-size: 12px; }
  .cal-day ul { margin: 0; flex: 1; }
  .cal-ev { font-size: 14px; }
}
.kb-cur { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 8px; }
tr.kb-cur { outline-offset: -2px; border-radius: 0; }
.cal-ev.kb-cur { outline-offset: 1px; border-radius: 4px; }
.kb-hint, .feed-link { font-size: 12px; }
.feed-link a { color: var(--muted); }
.kb-hint a { color: var(--muted); }
@media (hover: none) { .kb-hint { display: none; } }
.kb-help { position: fixed; inset: 0; z-index: 10; background: rgba(0, 0, 0, .4); display: flex; align-items: center; justify-content: center; padding: 16px; }
.kb-help[hidden] { display: none; }
.kb-box { background: var(--panel); color: var(--text); border-radius: 12px; padding: 20px 24px; max-width: 420px; width: 100%; box-shadow: 0 10px 40px rgba(0, 0, 0, .25); }
.kb-box h2 { margin: 0 0 12px; font-size: 17px; }
.kb-box dl { display: grid; grid-template-columns: auto 1fr; gap: 6px 16px; margin: 0 0 16px; font-size: 14px; }
.kb-box dt { white-space: nowrap; }
.kb-box dd { margin: 0; color: var(--muted); }
.kb-box kbd { font: 12px ui-monospace, monospace; padding: 1px 6px; border: 1px solid var(--line); border-radius: 4px; background: var(--bg); }
.kb-box button { font: inherit; font-size: 14px; padding: 6px 14px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--text); cursor: pointer; }
.pager { display: flex; justify-content: space-between; align-items: center; margin: 24px 0; font-size: 14px; color: var(--muted); }
.pager a { color: var(--accent); text-decoration: none; }
.sources { margin: 48px 0 40px; padding-top: 20px; border-top: 1px solid var(--line); font-size: 13px; color: var(--muted); }
.sources h3 { font-size: 13px; margin: 0 0 6px; }
.sources ul { margin: 0 0 12px; padding-left: 18px; }
.cards { list-style: none; margin: 16px 0 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 20px; }
.card-link { display: flex; flex-direction: column; height: 100%; text-decoration: none; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
a.card-link:hover .entry-title { color: var(--accent); }
.card-media { position: relative; aspect-ratio: 16 / 10; background: var(--accent-weak); display: flex; align-items: center; justify-content: center; overflow: hidden; }
.card-noimg { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 16px; text-align: center; color: var(--accent); font-size: 14px; font-weight: 600; opacity: .8; }
.card-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; background: var(--line); }
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
  /* カードはスマホでは横並び（左に正方形の画像、右に本文）にして一覧性を上げる */
  .cards { grid-template-columns: 1fr; gap: 10px; margin-top: 12px; }
  .card-link { flex-direction: row; align-items: stretch; }
  .card-media { flex: 0 0 104px; width: 104px; aspect-ratio: auto; min-height: 104px; }
  .card-noimg { padding: 6px; font-size: 11px; gap: 4px; }
  .card-body { flex: 1; min-width: 0; padding: 10px 12px; display: flex; flex-direction: column; gap: 4px; }
  .card .entry-title { font-size: 15px; line-height: 1.4; margin: 0; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .card .excerpt { font-size: 12px; line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .card .entry-meta, .card .fields, .card .period { font-size: 12px; margin: 0; }
  .card .fields { gap: 0 12px; }
}
`;
