// ジョブ（キュー兼リース）・スケジューラ（docs/design.md §6）
import type { ItemImagesInstruction, LeasedJob, ProbeRequest, RunTrigger, SubscriptionConfig } from "@ws/shared";
import { type Env, newId, nowIso, addMinutes, randomToken, nextRunAt, json } from "./env.js";

const LEASE_MINUTES = 5;
const RETRY_BACKOFF_MIN = [15, 60];

export interface SubRow {
  id: string;
  input_url: string;
  display_title: string | null;
  status: string;
  active_config_version_id: string | null;
  schedule_minute_of_day: number;
  schedule_interval_minutes: number;
  timezone: string;
  next_run_at: string | null;
  last_attempt_at: string | null;
  last_success_at: string | null;
  last_change_at: string | null;
  baseline_status: "none" | "partial" | "complete";
  baseline_identity_scheme: string | null;
  health: string;
  health_detail: string | null;
  consecutive_failures: number;
  consecutive_extract_failures: number;
  current_setup_session_id: string | null;
  item_image_mode: "og_image" | "off" | null;
  created_at: string;
  updated_at: string;
}

/** クロールを投入。同一購読先で queued/leased のジョブがあれば null（重複させない） */
export async function enqueueCrawl(env: Env, sub: SubRow, trigger: RunTrigger, opts: { notBefore?: string; retryOf?: string } = {}): Promise<{ runId: string; jobId: string } | null> {
  if (!sub.active_config_version_id) return null;
  const cv = await env.DB.prepare("SELECT identity_scheme_hash FROM config_versions WHERE id = ?").bind(sub.active_config_version_id).first<{ identity_scheme_hash: string }>();
  if (!cv) return null;
  const runId = newId();
  const jobId = newId();
  const now = nowIso();
  const baselineRun = sub.baseline_status !== "complete" ? 1 : 0;
  const rebaseline = sub.baseline_status === "complete" && sub.baseline_identity_scheme && sub.baseline_identity_scheme !== cv.identity_scheme_hash ? 1 : 0;
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO jobs (id, kind, subscription_id, run_id, status, not_before, priority, attempt, max_attempts, created_at) VALUES (?, 'crawl', ?, ?, 'queued', ?, ?, ?, 3, ?)",
      ).bind(jobId, sub.id, runId, opts.notBefore ?? now, trigger === "manual" || trigger === "activation" ? 5 : 0, 0, now),
      env.DB.prepare(
        "INSERT INTO crawl_runs (id, subscription_id, job_id, trigger, config_version_id, queued_at, run_status, baseline_run, rebaseline, retry_of_run_id) VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)",
      ).bind(runId, sub.id, jobId, trigger, sub.active_config_version_id, now, baselineRun || rebaseline, rebaseline, opts.retryOf ?? null),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE")) return null;
    throw e;
  }
  return { runId, jobId };
}

export async function enqueueProbe(env: Env, sessionId: string | null, req: ProbeRequest): Promise<string> {
  const probeId = newId();
  const now = nowIso();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO probes (id, session_id, kind, request_json, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)").bind(probeId, sessionId, req.kind, JSON.stringify(req), now),
    env.DB.prepare("INSERT INTO jobs (id, kind, probe_id, status, not_before, priority, attempt, max_attempts, created_at) VALUES (?, 'probe', ?, 'queued', ?, 10, 0, 2, ?)").bind(newId(), probeId, now, now),
  ]);
  return probeId;
}

interface JobRow {
  id: string;
  kind: "crawl" | "probe";
  subscription_id: string | null;
  run_id: string | null;
  probe_id: string | null;
  attempt: number;
  lease_token: string;
  lease_expires_at: string;
}

export async function leaseJobs(env: Env, workerId: string, capacity: number, kinds: string[]): Promise<LeasedJob[]> {
  const out: LeasedJob[] = [];
  const kindList = kinds.filter((k) => k === "crawl" || k === "probe");
  if (!kindList.length) return out;
  for (let i = 0; i < Math.min(capacity, 8); i++) {
    const now = nowIso();
    const token = randomToken(16);
    // 単一文で原子的に1件確保
    const row = await env.DB.prepare(
      `UPDATE jobs SET status = 'leased', lease_token = ?, lease_owner = ?, lease_expires_at = ?, attempt = attempt + 1
       WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND not_before <= ? AND kind IN (${kindList.map(() => "?").join(",")}) ORDER BY priority DESC, not_before LIMIT 1)
       RETURNING id, kind, subscription_id, run_id, probe_id, attempt, lease_token, lease_expires_at`,
    )
      .bind(token, workerId, addMinutes(now, LEASE_MINUTES), now, ...kindList)
      .first<JobRow>();
    if (!row) break;
    if (row.kind === "crawl") {
      const run = await env.DB.prepare("SELECT r.config_version_id, c.config_json FROM crawl_runs r JOIN config_versions c ON c.id = r.config_version_id WHERE r.id = ?")
        .bind(row.run_id)
        .first<{ config_version_id: string; config_json: string }>();
      if (!run) {
        await env.DB.prepare("UPDATE jobs SET status = 'failed', finished_at = ? WHERE id = ?").bind(now, row.id).run();
        continue;
      }
      await env.DB.prepare("UPDATE crawl_runs SET run_status = 'running', started_at = COALESCE(started_at, ?), worker_id = ? WHERE id = ?").bind(now, workerId, row.run_id).run();
      const itemImages = await itemImagesInstruction(env, row.subscription_id!, run.config_version_id);
      out.push({
        job_id: row.id,
        kind: "crawl",
        lease_token: row.lease_token,
        lease_expires_at: row.lease_expires_at,
        attempt: row.attempt,
        run_id: row.run_id!,
        subscription_id: row.subscription_id!,
        config_version_id: run.config_version_id,
        config: JSON.parse(run.config_json) as SubscriptionConfig,
        ...(itemImages ? { item_images: itemImages } : {}),
      });
    } else {
      const p = await env.DB.prepare("SELECT request_json FROM probes WHERE id = ?").bind(row.probe_id).first<{ request_json: string }>();
      if (!p) continue;
      await env.DB.prepare("UPDATE probes SET status = 'running' WHERE id = ?").bind(row.probe_id).run();
      out.push({ job_id: row.id, kind: "probe", lease_token: row.lease_token, lease_expires_at: row.lease_expires_at, attempt: row.attempt, probe_id: row.probe_id!, probe: JSON.parse(p.request_json) });
    }
  }
  return out;
}

/** リンク先 og:image の取得指示。画像あり・確認済みの item は除外する */
async function itemImagesInstruction(env: Env, subId: string, configVersionId: string): Promise<ItemImagesInstruction | null> {
  const sub = await env.DB.prepare("SELECT item_image_mode FROM subscriptions WHERE id = ?").bind(subId).first<{ item_image_mode: string | null }>();
  if (!sub || sub.item_image_mode === "off") return null;
  const cv = await env.DB.prepare("SELECT identity_scheme_hash FROM config_versions WHERE id = ?").bind(configVersionId).first<{ identity_scheme_hash: string }>();
  const rs = await env.DB.prepare("SELECT identity_key FROM items WHERE subscription_id = ? AND identity_scheme = ? AND (image_url IS NOT NULL OR image_checked_at IS NOT NULL)")
    .bind(subId, cv?.identity_scheme_hash ?? "")
    .all<{ identity_key: string }>();
  return { mode: sub.item_image_mode === "og_image" ? "on" : "trial", skip_keys: rs.results.map((r) => r.identity_key) };
}

export async function extendLease(env: Env, jobId: string, token: string): Promise<string | null> {
  const exp = addMinutes(nowIso(), LEASE_MINUTES);
  const r = await env.DB.prepare("UPDATE jobs SET lease_expires_at = ? WHERE id = ? AND lease_token = ? AND status = 'leased' RETURNING lease_expires_at").bind(exp, jobId, token).first<{ lease_expires_at: string }>();
  return r?.lease_expires_at ?? null;
}

/** 失敗した実行の同日内リトライ（一時的失敗のみ） */
export async function scheduleRetry(env: Env, subId: string, runId: string, attempt: number) {
  if (attempt > RETRY_BACKOFF_MIN.length) return;
  const sub = await env.DB.prepare("SELECT * FROM subscriptions WHERE id = ?").bind(subId).first<SubRow>();
  if (!sub || sub.status !== "active") return;
  await enqueueCrawl(env, sub, "retry", { notBefore: addMinutes(nowIso(), RETRY_BACKOFF_MIN[attempt - 1]), retryOf: runId });
}

export async function retryCountOf(env: Env, runId: string): Promise<number> {
  let n = 0;
  let cur: string | null = runId;
  while (cur && n < 10) {
    const r: { retry_of_run_id: string | null } | null = await env.DB.prepare("SELECT retry_of_run_id FROM crawl_runs WHERE id = ?").bind(cur).first();
    cur = r?.retry_of_run_id ?? null;
    if (cur) n++;
  }
  return n;
}

/** Cron：リース期限切れ回収と定期実行の投入 */
export async function tick(env: Env, finalizeExpired: (runId: string) => Promise<void>, probeFailed: (probeId: string, err: string) => Promise<void>) {
  const now = nowIso();
  const expired = await env.DB.prepare("SELECT id, kind, run_id, probe_id, attempt, max_attempts FROM jobs WHERE status = 'leased' AND lease_expires_at < ?").bind(now).all<{
    id: string;
    kind: string;
    run_id: string | null;
    probe_id: string | null;
    attempt: number;
    max_attempts: number;
  }>();
  for (const j of expired.results) {
    if (j.kind === "probe" && j.attempt < j.max_attempts) {
      await env.DB.prepare("UPDATE jobs SET status = 'queued', lease_token = NULL WHERE id = ? AND status = 'leased'").bind(j.id).run();
      continue;
    }
    await env.DB.prepare("UPDATE jobs SET status = 'failed', finished_at = ? WHERE id = ? AND status = 'leased'").bind(now, j.id).run();
    if (j.kind === "crawl" && j.run_id) await finalizeExpired(j.run_id);
    if (j.kind === "probe" && j.probe_id) await probeFailed(j.probe_id, "lease_expired");
  }

  const due = await env.DB.prepare("SELECT * FROM subscriptions WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ? LIMIT 200").bind(now).all<SubRow>();
  for (const sub of due.results) {
    await enqueueCrawl(env, sub, "scheduled");
    await env.DB.prepare("UPDATE subscriptions SET next_run_at = ? WHERE id = ?").bind(nextRunAt(sub.schedule_minute_of_day, sub.schedule_interval_minutes, sub.timezone), sub.id).run();
  }
  // 保存期間：実行履歴（CrawlRun/CrawlPage）1年、送信の冪等記録 30日。1時間に1回、少量ずつ削除
  if (new Date().getUTCMinutes() < 5) {
    const yearAgo = new Date(Date.now() - 365 * 86400000).toISOString();
    const old = `SELECT id FROM crawl_runs WHERE queued_at < '${yearAgo}' LIMIT 500`;
    await env.DB.batch([
      env.DB.prepare("DELETE FROM submissions WHERE created_at < ?").bind(new Date(Date.now() - 30 * 86400000).toISOString()),
      env.DB.prepare(`DELETE FROM crawl_pages WHERE run_id IN (${old})`),
      env.DB.prepare(`DELETE FROM item_observations WHERE run_id IN (${old})`),
      env.DB.prepare(`DELETE FROM crawl_runs WHERE id IN (${old})`),
    ]);
  }
  return { expired: expired.results.length, scheduled: due.results.length };
}

export function parseCfg(s: string): SubscriptionConfig {
  return json<SubscriptionConfig>(s, null as unknown as SubscriptionConfig);
}
