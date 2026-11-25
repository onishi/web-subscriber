// item のリンク先から og:image を取得する（配信元データに画像がない item のみ）。
// og:image がサイト共通の画像（複数の item で同じ）なら、本文の画像（特徴画像）を代わりに使う
import { itemImageFromData, primaryLink, type ItemImagesInstruction, type SubmittedItem } from "@ws/shared";
import { checkRobots, httpGet, FetchError } from "./net.js";
import { settings } from "./settings.js";

/** 試行モードで「見つからない」と判断するまでの件数 */
export const TRIAL_LIMIT = 3;
/** 1回の実行で取得するリンク先の上限（残りは次回以降） */
export const RUN_LIMIT = 30;
const RUN_BUDGET_MS = 120_000;
const HEAD_BYTES = 256 * 1024;

/** HTML の <head> から og:image（なければ twitter:image）を取り出す */
export function parseOgImage(html: string, baseUrl: string): string | null {
  const head = html.slice(0, HEAD_BYTES);
  const end = head.search(/<\/head\s*>/i);
  const scope = end >= 0 ? head.slice(0, end) : head;
  const metas: Record<string, string> = {};
  for (const m of scope.matchAll(/<meta\b[^>]*>/gi)) {
    const attrs: Record<string, string> = {};
    for (const a of m[0].matchAll(/([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
    const key = (attrs.property ?? attrs.name ?? "").toLowerCase();
    if (key && attrs.content && !(key in metas)) metas[key] = attrs.content;
  }
  const raw = metas["og:image:secure_url"] ?? metas["og:image"] ?? metas["og:image:url"] ?? metas["twitter:image"] ?? metas["twitter:image:src"];
  if (!raw) return null;
  try {
    const u = new URL(decodeEntities(raw.trim()), baseUrl);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** 本文の画像（特徴画像）の候補：main / article の中（なければ header・nav・footer を除いた本文）で、ロゴ・アイコン・小さい画像を除いた最初の画像 */
export function parsePageImage(html: string, baseUrl: string, exclude: Set<string> = new Set()): string | null {
  const body = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, "");
  const scope = (
    /<article\b[\s\S]*?<\/article\s*>/i.exec(body)?.[0] ??
    /<main\b[\s\S]*?<\/main\s*>/i.exec(body)?.[0] ??
    body.replace(/^[\s\S]*?<body\b[^>]*>/i, "")
  ).replace(/<(header|nav|footer|aside)\b[\s\S]*?<\/\1\s*>/gi, "");
  for (const m of scope.matchAll(/<img\b[^>]*>/gi)) {
    const attrs: Record<string, string> = {};
    for (const a of m[0].matchAll(/([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g)) attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? "";
    const src = attrs["data-src"] || attrs["data-lazy-src"] || attrs["data-original"] || attrs.src || (attrs.srcset ?? "").split(/\s+/)[0];
    if (!src || src.startsWith("data:")) continue;
    const w = Number(attrs.width), h = Number(attrs.height);
    if ((w && w < 200) || (h && h < 120)) continue;
    const hint = `${src} ${attrs.class ?? ""} ${attrs.id ?? ""} ${attrs.alt ?? ""}`.toLowerCase();
    if (/\.svg(\?|$)|\/themes?\/|logo|icon|sprite|banner|btn|button|arrow|spacer|blank|loading|avatar|sns|share|twitter|facebook|instagram|line_|ロゴ|アイコン/.test(hint)) continue;
    try {
      const u = new URL(decodeEntities(src.trim()), baseUrl);
      if ((u.protocol === "http:" || u.protocol === "https:") && !exclude.has(u.toString())) return u.toString();
    } catch {
      /* 次の候補 */
    }
  }
  return null;
}

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" })[e] ?? _);
}

export interface PageImages {
  og: string | null;
  page: string | null;
}

/** ページの og:image と本文の画像。取得できなければ null（一時的な失敗は undefined） */
export async function fetchPageImages(link: string, opts: { minIntervalMs: number; timeoutMs?: number; respectRobots: boolean }, exclude?: Set<string>): Promise<PageImages | null | undefined> {
  try {
    if (opts.respectRobots && !(await checkRobots(link)).allowed) return null;
    const res = await httpGet(link, { timeoutMs: opts.timeoutMs ?? 15000, minIntervalMs: opts.minIntervalMs, cacheTtlMs: settings.httpCacheLinkTtlMs });
    if (res.status >= 500 || res.status === 429 || res.status === 408) return undefined;
    if (res.status < 200 || res.status >= 300) return null;
    if (!/html/i.test(res.headers["content-type"] ?? "text/html")) return null;
    const og = parseOgImage(res.body, res.url);
    return { og, page: parsePageImage(res.body, res.url, new Set([...(exclude ?? []), ...(og ? [og] : [])])) };
  } catch (e) {
    return e instanceof FetchError && e.retryable ? undefined : null;
  }
}

/** ページの og:image。見つからない・取得できなければ null（一時的な失敗は undefined） */
export async function fetchOgImage(link: string, opts: { minIntervalMs: number; timeoutMs?: number; respectRobots: boolean }): Promise<string | null | undefined> {
  const r = await fetchPageImages(link, opts);
  return r === undefined ? undefined : (r?.og ?? null);
}

export class ImageEnricher {
  tried = 0;
  found = 0;
  private skip: Set<string>;
  private deadline = Date.now() + RUN_BUDGET_MS;
  /** サイト共通の og:image（API が知っているもの＋この実行で2件以上に共通したもの） */
  private generic: Set<string>;
  private ogCount = new Map<string, number>();

  constructor(
    private instr: ItemImagesInstruction,
    private opts: { minIntervalMs: number; timeoutMs?: number; respectRobots: boolean },
  ) {
    this.skip = new Set(instr.skip_keys);
    this.generic = new Set(instr.generic_images ?? []);
  }

  /** 試行で見つからなかった（以降は取得しない） */
  get givenUp(): boolean {
    return this.instr.mode === "trial" && this.found === 0 && this.tried >= TRIAL_LIMIT;
  }

  stats() {
    return { mode: this.instr.mode, tried: this.tried, found: this.found };
  }

  async enrich(items: SubmittedItem[]): Promise<void> {
    const got: { it: SubmittedItem; r: PageImages | null }[] = [];
    for (const it of items) {
      if (this.givenUp || this.tried >= RUN_LIMIT || Date.now() > this.deadline) break;
      if (!it.valid || !it.identity_key || this.skip.has(it.identity_key)) continue;
      if (itemImageFromData(it.data)) continue;
      const link = primaryLink(it.data);
      if (!link || !/^https?:\/\//.test(link)) continue;
      this.skip.add(it.identity_key);
      const r = await fetchPageImages(link, this.opts, this.generic);
      if (r === undefined) continue; // 一時的な失敗：確認済みにせず次回に回す
      this.tried++;
      if (r?.og || r?.page) this.found++;
      if (r?.og) this.ogCount.set(r.og, (this.ogCount.get(r.og) ?? 0) + 1);
      got.push({ it, r });
    }
    // og:image が2件以上で同じならサイト共通の画像とみなし、本文の画像を使う
    for (const [u, n] of this.ogCount) if (n >= 2) this.generic.add(u);
    for (const { it, r } of got) {
      const og = r?.og ?? null;
      if (og && this.generic.has(og)) {
        const page = r?.page && !this.generic.has(r.page) ? r.page : null;
        it.image_lookup = page ? { url: page, source: "page_image" } : { url: og, source: "og_generic" };
      } else it.image_lookup = { url: og ?? r?.page ?? null, source: og ? "og_image" : r?.page ? "page_image" : undefined };
    }
  }
}
