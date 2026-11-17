// セットの公開ページ（認証なし）。本番は PUBLIC_HOST（radar.wagaya.org）の /<slug>、開発時は /p/<slug>
// フィードリーダーではなく「特定カテゴリの新着情報一覧」として、サーバー側で HTML を組み立てて返す。
import { Hono } from "hono";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { type Env, json } from "./env.js";
import { displayValue, loadFields, type SetField } from "./fields.js";

export type PublicLayout = "list" | "cards" | "compact" | "table";
export type PublicTab = "now" | "upcoming" | "all";
/** 並べ替えのキー：published（日付）/ first_seen（収集日）/ title / f:<フィールドのキー> */
export interface PublicSort {
  key: string;
  dir: "asc" | "desc";
}
export interface PublicOptions {
  /** 表示するカスタムフィールドのキー（この順で表示。期間に使うキーは期間としてまとめて表示） */
  fields?: string[];
  /** 期間（開始・終了の日付フィールド）。「開催中 / これから / すべて」のタブを出す */
  period?: { start: string; end: string } | null;
  /** 絞り込みチップに使う複数値（または テキスト）フィールド */
  facet?: string | null;
  layout?: PublicLayout;
  /** 標準項目の表示（未指定は表示） */
  show?: { date?: boolean; source?: boolean; period?: boolean; excerpt?: boolean; image?: boolean };
  excerpt_length?: number;
  per_page?: number;
  /** タブごとの並び順（期間を使わないときは all だけを使う） */
  sort?: Partial<Record<PublicTab, PublicSort>>;
  default_tab?: PublicTab;
}

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const LAYOUTS: PublicLayout[] = ["list", "cards", "compact", "table"];
const TABS: PublicTab[] = ["now", "upcoming", "all"];
const DEFAULT_SORT: Record<PublicTab, PublicSort> = { now: { key: "period_end", dir: "asc" }, upcoming: { key: "period_start", dir: "asc" }, all: { key: "published", dir: "desc" } };
const clampInt = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : d);

/** 保存時・表示時の両方で使う。存在しないフィールドや不正な値は捨てて既定値に寄せる */
export function normalizePublicOptions(o: PublicOptions | null | undefined, fields: SetField[]): Required<Omit<PublicOptions, "period" | "facet">> & Pick<PublicOptions, "period" | "facet"> {
  o = o ?? {};
  const keys = new Map(fields.map((f) => [f.key, f]));
  const period = o.period && keys.get(o.period.start)?.type === "date" && keys.get(o.period.end)?.type === "date" ? { start: o.period.start, end: o.period.end } : null;
  const sortKeyOk = (k: unknown) =>
    typeof k === "string" && (["published", "first_seen", "title"].includes(k) || (period && (k === "period_start" || k === "period_end")) || (k.startsWith("f:") && keys.has(k.slice(2))));
  const sort: Partial<Record<PublicTab, PublicSort>> = {};
  for (const t of period ? TABS : (["all"] as PublicTab[])) {
    const x = o.sort?.[t];
    sort[t] = x && sortKeyOk(x.key) ? { key: x.key, dir: x.dir === "asc" ? "asc" : "desc" } : t === "all" || period ? DEFAULT_SORT[t] : DEFAULT_SORT.all;
  }
  const show = o.show ?? {};
  return {
    fields: [...new Set((o.fields ?? []).filter((k) => keys.has(k)))],
    period,
    facet: o.facet && ["list", "text"].includes(keys.get(o.facet)?.type ?? "") ? o.facet : null,
    layout: LAYOUTS.includes(o.layout as PublicLayout) ? (o.layout as PublicLayout) : "list",
    show: { date: show.date !== false, source: show.source !== false, period: show.period !== false, excerpt: show.excerpt !== false, image: show.image !== false },
    excerpt_length: clampInt(o.excerpt_length, 20, 400, 140),
    per_page: clampInt(o.per_page, 10, 100, 30),
    sort,
    default_tab: period && TABS.includes(o.default_tab as PublicTab) ? (o.default_tab as PublicTab) : "now",
  };
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
  const shown = (opts.fields ?? []).map((k) => byKey.get(k)).filter((f): f is SetField => !!f && f.id !== period?.start.id && f.id !== period?.end.id);

  const today = jstToday();
  const tab: PublicTab = period ? (TABS.includes(c.req.query("tab") as PublicTab) ? (c.req.query("tab") as PublicTab) : opts.default_tab) : "all";
  const facetValue = facet ? c.req.query("v") ?? "" : "";
  const page = Math.max(1, Math.min(100, Number(c.req.query("page") ?? 1) || 1));

  const where = ["i.subscription_id IN (SELECT m.subscription_id FROM set_members m JOIN subscriptions s ON s.id = m.subscription_id WHERE m.set_id = ? AND s.status != 'archived')", "(i.title_text IS NOT NULL OR i.primary_link IS NOT NULL)"];
  const args: unknown[] = [st.id];
  const col = (f: SetField) => (f.type === "date" ? "value_date" : f.type === "number" || f.type === "boolean" ? "value_num" : "value_text");
  const v = (f: SetField, agg: "MIN" | "MAX") => `(SELECT ${agg}(${col(f)}) FROM item_field_values WHERE item_id = i.id AND field_id = '${f.id.replace(/[^0-9A-Za-z]/g, "")}')`;
  if (period) {
    const s = v(period.start, "MIN");
    const e = v(period.end, "MAX");
    if (tab === "now") {
      where.push(`${s} <= ? AND COALESCE(${e}, ${s}) >= ?`);
      args.push(today, today);
    } else if (tab === "upcoming") {
      where.push(`${s} > ?`);
      args.push(today);
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
  const rs = await c.env.DB.prepare(
    `SELECT i.id, i.subscription_id, i.title_text, i.primary_link, i.first_seen_at, i.last_changed_at,
       COALESCE(i.image_url, json_extract(i.detail_json, '$.native.extracted_fields.image')) AS image,
       COALESCE(json_extract(i.detail_json, '$.summary.value'), json_extract(i.data_json, '$.summary.value'), json_extract(i.detail_json, '$.content.value'), json_extract(i.data_json, '$.content.value')) AS summary,
       COALESCE(json_extract(i.detail_json, '$.published_at.value'), json_extract(i.data_json, '$.published_at.value')) AS published
     FROM items i WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ? OFFSET ?`,
  )
    .bind(...args, PER_PAGE + 1, (page - 1) * PER_PAGE)
    .all<{ id: string; subscription_id: string; title_text: string | null; primary_link: string | null; first_seen_at: string; last_changed_at: string | null; image: string | null; summary: string | null; published: string | null }>();
  const items = rs.results.slice(0, PER_PAGE);

  // 情報源（購読先）
  const sources = await c.env.DB.prepare(
    `SELECT s.id, s.input_url, s.last_success_at, COALESCE(s.display_title, json_extract(ch.data_json, '$.title.value'), s.input_url) AS title, json_extract(ch.data_json, '$.logo.url') AS logo,
       (SELECT json_extract(value, '$.href') FROM json_each(ch.data_json, '$.links') WHERE json_extract(value, '$.rel') = 'alternate' LIMIT 1) AS home
     FROM set_members m JOIN subscriptions s ON s.id = m.subscription_id LEFT JOIN channels ch ON ch.subscription_id = s.id
     WHERE m.set_id = ? AND s.status != 'archived' ORDER BY m.added_at`,
  )
    .bind(st.id)
    .all<{ id: string; input_url: string; last_success_at: string | null; title: string; logo: string | null; home: string | null }>();
  const src = new Map(sources.results.map((s) => [s.id, s]));
  const updated = sources.results.map((s) => s.last_success_at).filter(Boolean).sort().pop() ?? null;

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

  // 絞り込みチップ
  let chips: { value: string; count: number }[] = [];
  if (facet) {
    const fr = await c.env.DB.prepare("SELECT value_text AS value, COUNT(DISTINCT item_id) AS count FROM item_field_values WHERE field_id = ? AND value_text IS NOT NULL GROUP BY value_text ORDER BY count DESC LIMIT 30")
      .bind(facet.id)
      .all<{ value: string; count: number }>();
    chips = fr.results;
  }

  const title = (st.public_title as string) || (st.name as string);
  const description = (st.public_description as string) || "";
  const q = (o: Record<string, string | number | undefined>) => {
    const p = new URLSearchParams();
    const all = { token: preview ? token : undefined, tab: period ? tab : undefined, v: facetValue || undefined, ...o };
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
    return {
      s,
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
  const fieldsEl = (vals: Map<string, unknown[]> | undefined) =>
    shown.some((f) => vals?.get(f.key)?.length)
      ? html`<dl class="fields">${shown.filter((f) => vals?.get(f.key)?.length).map((f) => html`<div><dt>${f.label}</dt><dd>${fmtVal(f, vals!.get(f.key)!)}</dd></div>`)}</dl>`
      : "";
  const wrapLink = (link: string | null, cls: string, body: H) =>
    link ? html`<a class="${cls}" href="${link}" target="_blank" rel="noopener">${body}</a>` : html`<div class="${cls}">${body}</div>`;

  const entry = (it: (typeof items)[number]) => {
    const x = view(it);
    if (kind === "compact") {
      return html`<li class="row-item">${wrapLink(
        x.link,
        "row-link",
        html`<span class="row-date">${x.periodText || x.dateEl}</span><span class="row-title">${x.title}</span>${x.sourceEl ? html`<span class="row-source">${x.sourceEl}</span>` : ""}`,
      )}</li>`;
    }
    if (kind === "cards") {
      return html`<li class="card">${wrapLink(
        x.link,
        "card-link",
        html`${x.img ? html`<img class="card-img" src="${x.img}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />` : ""}
          <div class="card-body">
            ${x.dateEl || x.sourceEl ? html`<div class="entry-meta">${x.dateEl}${x.sourceEl}</div>` : ""}
            <h2 class="entry-title">${x.title}</h2>
            ${x.periodText ? html`<p class="period">${x.periodText}</p>` : ""}
            ${x.ex ? html`<p class="excerpt">${x.ex}</p>` : ""}
            ${fieldsEl(x.vals)}
          </div>`,
      )}</li>`;
    }
    return html`<li class="entry">${wrapLink(
      x.link,
      "entry-link",
      html`<div class="entry-body">
          ${x.dateEl || x.sourceEl ? html`<div class="entry-meta">${x.dateEl}${x.sourceEl}</div>` : ""}
          <h2 class="entry-title">${x.title}</h2>
          ${x.periodText ? html`<p class="period">${x.periodText}</p>` : ""}
          ${x.ex ? html`<p class="excerpt">${x.ex}</p>` : ""}
          ${fieldsEl(x.vals)}
        </div>
        ${x.img ? html`<img class="thumb" src="${x.img}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />` : ""}`,
    )}</li>`;
  };

  const table = () => html`<div class="table-wrap">
    <table class="entries-table">
      <thead>
        <tr>
          ${show.period && period ? html`<th>期間</th>` : show.date ? html`<th>日付</th>` : ""}
          <th>タイトル</th>
          ${shown.map((f) => html`<th>${f.label}</th>`)}
          ${show.source ? html`<th>情報源</th>` : ""}
        </tr>
      </thead>
      <tbody>
        ${items.map((it) => {
          const x = view(it);
          return html`<tr>
            ${show.period && period ? html`<td class="nowrap">${x.periodText || x.dateEl}</td>` : show.date ? html`<td class="nowrap">${x.dateEl}</td>` : ""}
            <td class="t-title">${x.link ? html`<a href="${x.link}" target="_blank" rel="noopener">${x.title}</a>` : x.title}</td>
            ${shown.map((f) => html`<td>${x.vals?.get(f.key)?.length ? fmtVal(f, x.vals.get(f.key)!) : ""}</td>`)}
            ${show.source ? html`<td>${x.sourceEl}</td>` : ""}
          </tr>`;
        })}
      </tbody>
    </table>
  </div>`;

  const listEl = () =>
    kind === "table" ? table() : kind === "cards" ? html`<ol class="cards">${items.map(entry)}</ol>` : kind === "compact" ? html`<ol class="rows${show.period && period ? " has-period" : ""}">${items.map(entry)}</ol>` : html`<ol class="entries">${items.map(entry)}</ol>`;

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
          ${period
            ? html`<nav class="tabs" aria-label="期間">
                ${[
                  ["now", "開催中"],
                  ["upcoming", "これから"],
                  ["all", "すべて"],
                ].map(([k, l]) => html`<a href="${q({ tab: k, page: 1 })}" class="${tab === k ? "on" : ""}" ${tab === k ? raw('aria-current="page"') : ""}>${l}</a>`)}
              </nav>`
            : ""}
          ${chips.length
            ? html`<nav class="chips" aria-label="${facet!.label}">
                <a href="${q({ v: undefined, page: 1 })}" class="${facetValue ? "" : "on"}">すべて</a>
                ${chips.map((ch) => html`<a href="${q({ v: ch.value, page: 1 })}" class="${facetValue === ch.value ? "on" : ""}">${ch.value}<span>${ch.count}</span></a>`)}
              </nav>`
            : ""}
          ${items.length ? listEl() : html`<p class="empty">${tab === "now" ? "現在開催中の情報はありません。" : tab === "upcoming" ? "予定されている情報はありません。" : "まだ情報がありません。"}</p>`}
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
.rows.has-period .row-date { min-width: 13.2em; }
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
  .row-title { flex-basis: 100%; order: 2; }
  .row-source { max-width: none; }
  .rows.has-period .row-date { min-width: 0; }
  .entries-table .t-title { min-width: 12em; }
  .hero { padding: 32px 0 20px; }
  .entry-link { gap: 12px; padding: 18px 0; }
  .thumb { width: 96px; }
  .entry-title { font-size: 17px; }
}
`;
