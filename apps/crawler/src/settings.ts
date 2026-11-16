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
};
