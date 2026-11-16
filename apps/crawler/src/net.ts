// HTTP取得・User-Agent・robots.txt・SSRF対策
import { lookup } from "node:dns/promises";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { isIP } from "node:net";
import { CRAWLER_VERSION, USER_AGENT_PRODUCT } from "@ws/shared";
import { settings } from "./settings.js";

/** 例: "Web-Subscriber/0.0.1 (+https://example.com/about-crawler)" */
export function userAgent(): string {
  return `${USER_AGENT_PRODUCT}/${CRAWLER_VERSION} (+${settings.contactUrl})`;
}
/** browser 方式：Chromium のUAに製品トークンを付加（サイト互換性のため素のUAは残す） */
export function browserUserAgent(chromiumUa: string): string {
  return `${chromiumUa.replace("HeadlessChrome", "Chrome")} ${userAgent()}`;
}

// ---- SSRF ----
function isPrivateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
function isPrivateV6(ip: string): boolean {
  const x = ip.toLowerCase();
  if (x.startsWith("::ffff:")) return isPrivateV4(x.slice(7));
  return x === "::1" || x === "::" || x.startsWith("fc") || x.startsWith("fd") || x.startsWith("fe80");
}

export class BlockedHostError extends Error {}

export async function assertPublicUrl(raw: string): Promise<void> {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new BlockedHostError(`blocked_scheme:${u.protocol}`);
  if (settings.allowPrivateHosts) return;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true });
  for (const a of addrs) {
    if (a.family === 4 ? isPrivateV4(a.address) : isPrivateV6(a.address)) throw new BlockedHostError(`blocked_private_address:${host}`);
  }
}

// ---- 取得間隔（同一ホスト） ----
const lastHit = new Map<string, number>();
export async function politeWait(url: string, minIntervalMs: number) {
  const host = new URL(url).host;
  const last = lastHit.get(host) ?? 0;
  const wait = last + minIntervalMs - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastHit.set(host, Date.now());
}

export interface HttpResult {
  url: string; // 最終URL
  status: number;
  headers: Record<string, string>;
  body: string;
  redirects: string[];
  /** キャッシュから返したときの経過時間 */
  cacheAgeMs?: number;
}

export class FetchError extends Error {
  constructor(
    message: string,
    public retryable: boolean,
  ) {
    super(message);
  }
}

const MAX_BYTES = 10 * 1024 * 1024;

// ---- HTTP 応答のディスクキャッシュ ----
// テストや手動実行で同じURLを短時間に何度も取りに行かないため。2xx と 404/410 だけ保存し、5xx・429・通信エラーは保存しない。
const cacheDir = () => join(settings.dataDir, "http-cache");
const cacheKey = (url: string, headers?: Record<string, string>) =>
  createHash("sha256").update(JSON.stringify([url, Object.entries(headers ?? {}).sort()])).digest("hex");

function readCache(key: string, ttlMs: number): HttpResult | null {
  try {
    const p = join(cacheDir(), `${key}.json`);
    const age = Date.now() - statSync(p).mtimeMs;
    if (age > ttlMs) return null;
    return { ...(JSON.parse(readFileSync(p, "utf8")) as HttpResult), cacheAgeMs: Math.round(age) };
  } catch {
    return null;
  }
}

function writeCache(key: string, r: HttpResult) {
  try {
    mkdirSync(cacheDir(), { recursive: true });
    const p = join(cacheDir(), `${key}.json`);
    writeFileSync(`${p}.tmp`, JSON.stringify(r));
    renameSync(`${p}.tmp`, p);
  } catch {
    /* キャッシュは失敗しても取得結果には影響させない */
  }
}

/** 最長の保持期間を過ぎたキャッシュを削除 */
export function pruneHttpCache(): number {
  const maxAge = Math.max(settings.httpCacheSourceTtlMs, settings.httpCacheLinkTtlMs);
  let n = 0;
  try {
    for (const f of readdirSync(cacheDir())) {
      const p = join(cacheDir(), f);
      try {
        if (Date.now() - statSync(p).mtimeMs > maxAge) {
          rmSync(p, { force: true });
          n++;
        }
      } catch {
        /* 並行削除など */
      }
    }
  } catch {
    /* ディレクトリ未作成 */
  }
  return n;
}

export async function httpGet(
  url: string,
  opts: { headers?: Record<string, string>; timeoutMs: number; minIntervalMs?: number; cacheTtlMs?: number },
): Promise<HttpResult> {
  const useCache = settings.httpCache && !!opts.cacheTtlMs && opts.cacheTtlMs > 0;
  const key = useCache ? cacheKey(url, opts.headers) : "";
  if (useCache) {
    const hit = readCache(key, opts.cacheTtlMs!);
    if (hit) return hit;
  }
  const r = await httpGetNetwork(url, opts);
  if (useCache && ((r.status >= 200 && r.status < 300) || r.status === 404 || r.status === 410)) writeCache(key, r);
  return r;
}

async function httpGetNetwork(url: string, opts: { headers?: Record<string, string>; timeoutMs: number; minIntervalMs?: number }): Promise<HttpResult> {
  const redirects: string[] = [];
  let cur = url;
  for (let i = 0; i < 10; i++) {
    await assertPublicUrl(cur);
    if (opts.minIntervalMs !== undefined) await politeWait(cur, opts.minIntervalMs);
    let res: Response;
    try {
      res = await fetch(cur, {
        redirect: "manual",
        headers: { "User-Agent": userAgent(), Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,application/rss+xml,application/atom+xml,*/*;q=0.8", ...opts.headers },
        signal: AbortSignal.timeout(opts.timeoutMs),
      });
    } catch (e) {
      const err = e as Error & { cause?: { code?: string } };
      throw new FetchError(`network_error:${err.name === "TimeoutError" ? "timeout" : (err.cause?.code ?? err.message)}`, true);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      redirects.push(cur);
      cur = new URL(res.headers.get("location")!, cur).toString();
      await res.body?.cancel();
      continue;
    }
    const reader = res.body?.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) {
          await reader.cancel();
          throw new FetchError("response_too_large", false);
        }
        chunks.push(value);
      }
    }
    const buf = Buffer.concat(chunks);
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    return { url: cur, status: res.status, headers, body: decodeBody(buf, headers["content-type"]), redirects };
  }
  throw new FetchError("too_many_redirects", false);
}

function decodeBody(buf: Buffer, contentType: string | undefined): string {
  let charset = /charset=([^;\s]+)/i.exec(contentType ?? "")?.[1];
  if (!charset) {
    const head = buf.subarray(0, 2048).toString("latin1");
    charset = /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? /<\?xml[^>]+encoding=["']([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(charset ?? "utf-8").decode(buf);
  } catch {
    return new TextDecoder("utf-8").decode(buf);
  }
}

// ---- robots.txt ----
interface RobotsRules {
  rules: { allow: boolean; path: string }[];
  fetchedAt: number;
}
const robotsCache = new Map<string, RobotsRules>();

export function parseRobots(txt: string, token: string): { allow: boolean; path: string }[] {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = [];
  let cur: (typeof groups)[number] | null = null;
  let lastWasAgent = false;
  for (const lineRaw of txt.split(/\r?\n/)) {
    const line = lineRaw.replace(/#.*/, "").trim();
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) groups.push((cur = { agents: [], rules: [] }));
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (!cur) continue;
      if (key === "allow" || key === "disallow") {
        if (key === "disallow" && val === "") continue;
        cur.rules.push({ allow: key === "allow", path: val });
      }
    }
  }
  const t = token.toLowerCase();
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && t.includes(a)));
  const chosen = specific.length ? specific : groups.filter((g) => g.agents.includes("*"));
  return chosen.flatMap((g) => g.rules);
}

function ruleMatches(path: string, pattern: string): boolean {
  const re = new RegExp(
    "^" +
      pattern
        .split("")
        .map((c) => (c === "*" ? ".*" : c === "$" ? "$" : c.replace(/[.+?^{}()|[\]\\]/g, "\\$&")))
        .join(""),
  );
  return re.test(path);
}

export function robotsAllows(rules: { allow: boolean; path: string }[], pathAndQuery: string): boolean {
  let best: { allow: boolean; len: number } | null = null;
  for (const r of rules) {
    if (ruleMatches(pathAndQuery, r.path)) {
      const len = r.path.length;
      if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
    }
  }
  return best ? best.allow : true;
}

export async function checkRobots(url: string): Promise<{ allowed: boolean; detail: string }> {
  const u = new URL(url);
  const key = u.origin;
  let entry = robotsCache.get(key);
  if (!entry || Date.now() - entry.fetchedAt > 24 * 3600_000) {
    let rules: { allow: boolean; path: string }[] = [];
    try {
      const r = await httpGet(`${u.origin}/robots.txt`, { timeoutMs: 10000, cacheTtlMs: settings.httpCacheLinkTtlMs });
      if (r.status >= 200 && r.status < 300) rules = parseRobots(r.body, USER_AGENT_PRODUCT);
      // 4xx は制限なし。5xx は慎重に全拒否（RFC 9309）
      else if (r.status >= 500) rules = [{ allow: false, path: "/" }];
    } catch {
      rules = []; // 取得不能（接続不可）時は判定不能として許可し、本体取得側でエラーになる
    }
    entry = { rules, fetchedAt: Date.now() };
    robotsCache.set(key, entry);
  }
  const allowed = robotsAllows(entry.rules, u.pathname + u.search);
  return { allowed, detail: allowed ? "allowed" : `disallowed by ${u.origin}/robots.txt` };
}
