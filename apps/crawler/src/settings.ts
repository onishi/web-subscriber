import { hostname } from "node:os";

const env = process.env;

export const settings = {
  apiBase: (env.WS_API_BASE ?? "http://127.0.0.1:8787").replace(/\/$/, ""),
  workerToken: env.WS_WORKER_TOKEN ?? "",
  workerId: env.WS_WORKER_ID ?? hostname(),
  contactUrl: env.WS_CONTACT_URL ?? "https://github.com/onishi/web-subscriber",
  dataDir: env.WS_DATA_DIR ?? new URL("../data/", import.meta.url).pathname,
  pollIntervalMs: Number(env.WS_POLL_INTERVAL_MS ?? 10000),
  concurrency: Number(env.WS_CONCURRENCY ?? 2),
  /** 開発・テスト用：localhost のフィクスチャへアクセスを許可 */
  allowPrivateHosts: env.WS_ALLOW_PRIVATE_HOSTS === "1",
  headless: env.WS_HEADLESS !== "0",
  /** HTTP 応答のディスクキャッシュ（http 方式のみ。browser 方式は対象外）。0 で無効 */
  httpCache: env.WS_HTTP_CACHE !== "0",
  /** 購読元（フィード・一覧ページ）とプローブの取得 */
  httpCacheSourceTtlMs: Number(env.WS_HTTP_CACHE_SOURCE_TTL_MS ?? 10 * 60_000),
  /** item のリンク先（og:image）・robots.txt */
  httpCacheLinkTtlMs: Number(env.WS_HTTP_CACHE_LINK_TTL_MS ?? 24 * 3600_000),
};
