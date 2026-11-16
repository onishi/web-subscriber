// item のリンク先から og:image を取得する（配信元データに画像がない item のみ）
import { itemImageFromData, primaryLink, type ItemImagesInstruction, type SubmittedItem } from "@ws/shared";
import { checkRobots, httpGet, FetchError } from "./net.js";

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

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt|quot|#39|#x27);/g, (_, e: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", "#x27": "'" })[e] ?? _);
}

export class ImageEnricher {
  tried = 0;
  found = 0;
  private skip: Set<string>;
  private deadline = Date.now() + RUN_BUDGET_MS;

  constructor(
    private instr: ItemImagesInstruction,
    private opts: { minIntervalMs: number; timeoutMs?: number; respectRobots: boolean },
  ) {
    this.skip = new Set(instr.skip_keys);
  }

  /** 試行で見つからなかった（以降は取得しない） */
  get givenUp(): boolean {
    return this.instr.mode === "trial" && this.found === 0 && this.tried >= TRIAL_LIMIT;
  }

  stats() {
    return { mode: this.instr.mode, tried: this.tried, found: this.found };
  }

  async enrich(items: SubmittedItem[]): Promise<void> {
    for (const it of items) {
      if (this.givenUp || this.tried >= RUN_LIMIT || Date.now() > this.deadline) return;
      if (!it.valid || !it.identity_key || this.skip.has(it.identity_key)) continue;
      if (itemImageFromData(it.data)) continue;
      const link = primaryLink(it.data);
      if (!link || !/^https?:\/\//.test(link)) continue;
      this.skip.add(it.identity_key);
      const r = await this.lookup(link);
      if (r === undefined) continue; // 一時的な失敗：確認済みにせず次回に回す
      this.tried++;
      if (r) this.found++;
      it.image_lookup = { url: r };
    }
  }

  /** 見つかれば URL、ない・取得不可なら null、一時的な失敗なら undefined */
  private async lookup(link: string): Promise<string | null | undefined> {
    try {
      if (this.opts.respectRobots && !(await checkRobots(link)).allowed) return null;
      const res = await httpGet(link, { timeoutMs: this.opts.timeoutMs ?? 15000, minIntervalMs: this.opts.minIntervalMs });
      if (res.status >= 500 || res.status === 429 || res.status === 408) return undefined;
      if (res.status < 200 || res.status >= 300) return null;
      if (!/html/i.test(res.headers["content-type"] ?? "text/html")) return null;
      return parseOgImage(res.body, res.url);
    } catch (e) {
      return e instanceof FetchError && e.retryable ? undefined : null;
    }
  }
}
