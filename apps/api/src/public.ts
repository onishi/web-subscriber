// セットの公開ページ（認証なし）。本番は PUBLIC_HOST（radar.wagaya.org）の /<slug>、開発時は /p/<slug>
// フィードリーダーではなく「特定カテゴリの新着情報一覧」として、サーバー側で HTML を組み立てて返す。
import { Hono } from "hono";
import { html, raw } from "hono/html";
import type { HtmlEscapedString } from "hono/utils/html";
import { type Env, json } from "./env.js";
import { displayValue, loadFields, type SetField } from "./fields.js";

export interface PublicOptions {
  /** 表示するカスタムフィールドのキー（期間に使うキーは期間としてまとめて表示） */
  fields?: string[];
  /** 期間（開始・終了の日付フィールド）。「開催中 / これから / すべて」のタブを出す */
  period?: { start: string; end: string } | null;
  /** 絞り込みチップに使う複数値（または テキスト）フィールド */
  facet?: string | null;
}

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const PER_PAGE = 30;

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
  const st = await c.env.DB.prepare("SELECT * FROM sets WHERE public_slug = ? AND is_public = 1").bind(slug).first<Record<string, string | number | null>>();
  if (!st) return c.html(notFound(), 404);
  const opts = json<PublicOptions>(st.public_options_json as string | null, {});
  const fields = await loadFields(c.env, st.id as string);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const period = opts.period && byKey.get(opts.period.start)?.type === "date" && byKey.get(opts.period.end)?.type === "date" ? { start: byKey.get(opts.period.start)!, end: byKey.get(opts.period.end)! } : null;
  const facet = opts.facet ? byKey.get(opts.facet) ?? null : null;
  const shown = (opts.fields ?? []).map((k) => byKey.get(k)).filter((f): f is SetField => !!f && f.id !== period?.start.id && f.id !== period?.end.id);

  const today = jstToday();
  const tab = period ? (["now", "upcoming", "all"].includes(c.req.query("tab") ?? "") ? c.req.query("tab")! : "now") : "all";
  const facetValue = facet ? c.req.query("v") ?? "" : "";
  const page = Math.max(1, Math.min(100, Number(c.req.query("page") ?? 1) || 1));

  const where = ["i.subscription_id IN (SELECT m.subscription_id FROM set_members m JOIN subscriptions s ON s.id = m.subscription_id WHERE m.set_id = ? AND s.status != 'archived')", "(i.title_text IS NOT NULL OR i.primary_link IS NOT NULL)"];
  const args: unknown[] = [st.id];
  const v = (f: SetField, agg: "MIN" | "MAX") => `(SELECT ${agg}(value_date) FROM item_field_values WHERE item_id = i.id AND field_id = '${f.id.replace(/'/g, "")}')`;
  let order = "COALESCE(i.published_sort, i.first_seen_at) DESC, i.id DESC";
  if (period) {
    const s = v(period.start, "MIN");
    const e = v(period.end, "MAX");
    if (tab === "now") {
      where.push(`${s} <= ? AND COALESCE(${e}, ${s}) >= ?`);
      args.push(today, today);
      order = `COALESCE(${e}, '9999') ASC, ${s} DESC`; // 終了が近い順
    } else if (tab === "upcoming") {
      where.push(`${s} > ?`);
      args.push(today);
      order = `${s} ASC`; // 始まりが近い順
    }
  }
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
    const all = { tab: period ? tab : undefined, v: facetValue || undefined, ...o };
    for (const [k, val] of Object.entries(all)) if (val !== undefined && val !== "" && !(k === "page" && String(val) === "1")) p.set(k, String(val));
    const s = p.toString();
    return s ? `?${s}` : "?";
  };
  const fmtVal = (f: SetField, vals: unknown[]) => vals.map((x) => (f.type === "date" ? fmtDate(String(x)) : f.type === "boolean" ? (x ? "はい" : "いいえ") : String(x))).join("・");

  const entry = (it: (typeof items)[number]) => {
    const s = src.get(it.subscription_id);
    const link = safeUrl(it.primary_link);
    const img = safeUrl(it.image);
    const vals = values.get(it.id);
    const ps = period && vals?.get(period.start.key)?.[0];
    const pe = period && vals?.get(period.end.key)?.[0];
    const date = it.published ?? it.first_seen_at;
    const body = html`
      <div class="entry-body">
        <div class="entry-meta">
          ${period ? "" : html`<time datetime="${date.slice(0, 10)}">${fmtDate(date)}</time>`}
          ${s ? html`<span class="source">${safeUrl(s.logo) ? html`<img src="${safeUrl(s.logo)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ""}${s.title}</span>` : ""}
        </div>
        <h2 class="entry-title">${it.title_text ?? it.primary_link}</h2>
        ${ps || pe ? html`<p class="period">${fmtDate(String(ps ?? ""))}${pe && pe !== ps ? html` – ${fmtDate(String(pe))}` : ""}</p>` : ""}
        ${excerpt(it.summary) ? html`<p class="excerpt">${excerpt(it.summary)}</p>` : ""}
        ${shown.some((f) => vals?.get(f.key)?.length)
          ? html`<dl class="fields">${shown.filter((f) => vals?.get(f.key)?.length).map((f) => html`<div><dt>${f.label}</dt><dd>${fmtVal(f, vals!.get(f.key)!)}</dd></div>`)}</dl>`
          : ""}
      </div>
      ${img ? html`<img class="thumb" src="${img}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />` : ""}
    `;
    return html`<li class="entry">${link ? html`<a class="entry-link" href="${link}" target="_blank" rel="noopener">${body}</a>` : html`<div class="entry-link">${body}</div>`}</li>`;
  };

  c.header("Cache-Control", "public, max-age=300");
  return c.html(
    layout(
      title,
      description,
      html`
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
          ${items.length ? html`<ol class="entries">${items.map(entry)}</ol>` : html`<p class="empty">${tab === "now" ? "現在開催中の情報はありません。" : tab === "upcoming" ? "予定されている情報はありません。" : "まだ情報がありません。"}</p>`}
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
@media (max-width: 600px) {
  .hero { padding: 32px 0 20px; }
  .entry-link { gap: 12px; padding: 18px 0; }
  .thumb { width: 96px; }
  .entry-title { font-size: 17px; }
}
`;
