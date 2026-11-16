// Cloudflare API クライアント（ジョブ取得・リース延長・結果送信）と送信アウトボックス
import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LeasedJob } from "@ws/shared";
import { settings } from "./settings.js";

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: string,
  ) {
    super(`api_error ${status}: ${body.slice(0, 300)}`);
  }
  get permanent() {
    return this.status >= 400 && this.status < 500 && this.status !== 408 && this.status !== 429;
  }
}

async function call(method: string, path: string, body?: unknown, raw?: { data: Buffer; contentType: string }): Promise<unknown> {
  const res = await fetch(settings.apiBase + path, {
    method,
    headers: {
      Authorization: `Bearer ${settings.workerToken}`,
      ...(raw ? { "Content-Type": raw.contentType } : body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: raw ? new Uint8Array(raw.data) : body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  if (!res.ok) throw new ApiError(res.status, text);
  return text ? JSON.parse(text) : null;
}

export async function lease(capacity: number): Promise<LeasedJob[]> {
  const r = (await call("POST", "/worker/v1/jobs/lease", { worker_id: settings.workerId, capacity, kinds: ["crawl", "probe"] })) as { jobs: LeasedJob[] };
  return r.jobs;
}

export async function heartbeat(jobId: string, leaseToken: string): Promise<{ lease_expires_at: string } | null> {
  try {
    return (await call("POST", `/worker/v1/jobs/${jobId}/heartbeat`, { lease_token: leaseToken })) as { lease_expires_at: string };
  } catch {
    return null;
  }
}

export async function uploadArtifact(scope: "runs" | "probes", id: string, name: string, data: Buffer, contentType: string): Promise<string | null> {
  try {
    const r = (await call("PUT", `/worker/v1/${scope}/${id}/artifacts/${encodeURIComponent(name)}`, undefined, { data, contentType })) as { key: string };
    return r.key;
  } catch {
    return null; // 保存物は失敗しても本処理を止めない
  }
}

// ---- アウトボックス：送信前にディスクへ書き、成功まで順序どおり再送する ----
const outboxDir = () => {
  const d = join(settings.dataDir, "outbox");
  mkdirSync(d, { recursive: true });
  return d;
};
let seqCounter = 0;

interface OutboxEntry {
  path: string;
  body: unknown;
  /** 同じ run/probe の送信は順序を守る */
  stream: string;
}

export async function send(stream: string, path: string, body: unknown): Promise<unknown> {
  const name = `${Date.now().toString().padStart(15, "0")}-${(seqCounter++).toString().padStart(6, "0")}.json`;
  const file = join(outboxDir(), name);
  const entry: OutboxEntry = { path, body, stream };
  writeFileSync(file + ".tmp", JSON.stringify(entry));
  renameSync(file + ".tmp", file);
  // 同じストリームの未送信が残っていれば順序を守るため後回し
  if (pendingStreams().has(stream) && pendingFor(stream)[0] !== name) {
    void flushOutbox();
    throw new Error("queued_in_outbox");
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await call("POST", path, body);
      unlinkSync(file);
      return r;
    } catch (e) {
      if (e instanceof ApiError && e.permanent) {
        unlinkSync(file);
        throw e;
      }
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
  throw new Error("queued_in_outbox");
}

function pendingFiles(): string[] {
  return readdirSync(outboxDir())
    .filter((f) => f.endsWith(".json"))
    .sort();
}
function pendingFor(stream: string): string[] {
  return pendingFiles().filter((f) => {
    try {
      return (JSON.parse(readFileSync(join(outboxDir(), f), "utf8")) as OutboxEntry).stream === stream;
    } catch {
      return false;
    }
  });
}
function pendingStreams(): Set<string> {
  const s = new Set<string>();
  for (const f of pendingFiles()) {
    try {
      s.add((JSON.parse(readFileSync(join(outboxDir(), f), "utf8")) as OutboxEntry).stream);
    } catch {
      /* ignore */
    }
  }
  return s;
}

let flushing = false;
const backoff = new Map<string, { until: number; n: number }>();

/** 未送信分を古い順に再送。失敗したストリームは指数バックオフ（最大24時間保持） */
export async function flushOutbox(): Promise<number> {
  if (flushing) return 0;
  flushing = true;
  let sent = 0;
  try {
    const blocked = new Set<string>();
    for (const f of pendingFiles()) {
      const file = join(outboxDir(), f);
      let entry: OutboxEntry;
      try {
        entry = JSON.parse(readFileSync(file, "utf8"));
      } catch {
        unlinkSync(file);
        continue;
      }
      if (blocked.has(entry.stream)) continue;
      const b = backoff.get(entry.stream);
      if (b && b.until > Date.now()) {
        blocked.add(entry.stream);
        continue;
      }
      const age = Date.now() - Number(f.split("-")[0]);
      if (age > 24 * 3600_000) {
        unlinkSync(file);
        continue;
      }
      try {
        await call("POST", entry.path, entry.body);
        unlinkSync(file);
        backoff.delete(entry.stream);
        sent++;
      } catch (e) {
        if (e instanceof ApiError && e.permanent) {
          console.warn(`[outbox] drop ${entry.path}: ${e.message}`);
          unlinkSync(file);
          continue;
        }
        const n = (b?.n ?? 0) + 1;
        backoff.set(entry.stream, { until: Date.now() + Math.min(3600_000, 5000 * 2 ** n), n });
        blocked.add(entry.stream);
      }
    }
  } finally {
    flushing = false;
  }
  return sent;
}

export function outboxSize(): number {
  return pendingFiles().length;
}
