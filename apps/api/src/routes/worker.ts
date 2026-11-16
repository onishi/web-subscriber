// クローラ(VPS)向け API。利用者 API とは別の認証・権限（docs/design.md §6.4）
import { Hono } from "hono";
import type { PageSubmission, CompleteSubmission, ProbeResultSubmission } from "@ws/shared";
import { type Env, nowIso } from "../env.js";
import { workerAuth, type AppVars } from "../auth.js";
import { leaseJobs, extendLease } from "../jobs.js";
import { ingestPage, completeRun, HttpError } from "../ingest.js";
import { completeHooks, notifyProbe } from "../hooks.js";

export const workerApi = new Hono<{ Bindings: Env; Variables: AppVars }>();

workerApi.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.code }, err.status as 400);
  console.error(err);
  return c.json({ error: "internal", message: String(err) }, 500);
});

workerApi.post("/jobs/lease", workerAuth("jobs:lease"), async (c) => {
  const b = await c.req.json<{ capacity?: number; kinds?: string[] }>();
  const jobs = await leaseJobs(c.env, c.get("workerId"), Math.max(1, Math.min(b.capacity ?? 1, 8)), b.kinds ?? ["crawl", "probe"]);
  return c.json({ jobs });
});

workerApi.post("/jobs/:id/heartbeat", workerAuth("jobs:lease"), async (c) => {
  const b = await c.req.json<{ lease_token: string }>();
  const exp = await extendLease(c.env, c.req.param("id"), b.lease_token);
  if (!exp) return c.json({ error: "lease_lost" }, 409);
  return c.json({ lease_expires_at: exp });
});

workerApi.post("/runs/:id/pages/:seq", workerAuth("runs:write"), async (c) => {
  const b = await c.req.json<PageSubmission>();
  if (!b?.page || typeof b.page.seq !== "number" || String(b.page.seq) !== c.req.param("seq") || !Array.isArray(b.items) || !b.submission_key) return c.json({ error: "bad_request" }, 400);
  return c.json(await ingestPage(c.env, c.req.param("id"), b));
});

workerApi.post("/runs/:id/complete", workerAuth("runs:write"), async (c) => {
  const b = await c.req.json<CompleteSubmission>();
  if (!b?.submission_key || !b.traversal) return c.json({ error: "bad_request" }, 400);
  return c.json(await completeRun(c.env, c.req.param("id"), b, completeHooks(c.env)));
});

const safeName = (n: string) => n.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 100);

workerApi.put("/runs/:id/artifacts/:name", workerAuth("runs:write"), async (c) => {
  const run = await c.env.DB.prepare("SELECT subscription_id FROM crawl_runs WHERE id = ?").bind(c.req.param("id")).first<{ subscription_id: string }>();
  if (!run) return c.json({ error: "run_not_found" }, 404);
  // 保存期間ごとにプレフィックスを分ける（R2 ライフサイクルで削除）：フィードXML 90日、HTML/DOM/スクリーンショット 30日
  const name = safeName(c.req.param("name"));
  const key = `${name.endsWith(".xml.gz") ? "r90" : "r30"}/${run.subscription_id}/${c.req.param("id")}/${name}`;
  await c.env.BLOBS.put(key, c.req.raw.body, { httpMetadata: { contentType: c.req.header("Content-Type") ?? "application/octet-stream" } });
  return c.json({ key });
});

workerApi.put("/probes/:id/artifacts/:name", workerAuth("probes:write"), async (c) => {
  const key = `r30/probes/${c.req.param("id")}/${safeName(c.req.param("name"))}`;
  await c.env.BLOBS.put(key, c.req.raw.body, { httpMetadata: { contentType: c.req.header("Content-Type") ?? "application/octet-stream" } });
  return c.json({ key });
});

workerApi.post("/probes/:id/result", workerAuth("probes:write"), async (c) => {
  const probeId = c.req.param("id");
  const b = await c.req.json<ProbeResultSubmission>();
  const job = await c.env.DB.prepare("SELECT id, status, lease_token FROM jobs WHERE probe_id = ?").bind(probeId).first<{ id: string; status: string; lease_token: string }>();
  if (!job) return c.json({ error: "probe_not_found" }, 404);
  const prev = await c.env.DB.prepare("SELECT response_json FROM submissions WHERE job_id = ? AND submission_key = ?").bind(job.id, b.submission_key).first<{ response_json: string }>();
  if (prev) return c.json(JSON.parse(prev.response_json));
  if (job.lease_token !== b.lease_token || job.status !== "leased") return c.json({ error: "lease_lost" }, 409);
  const key = `r30/probes/${probeId}/result.json`;
  await c.env.BLOBS.put(key, JSON.stringify(b.summary ?? null), { httpMetadata: { contentType: "application/json" } });
  const now = nowIso();
  const resp = { ok: true };
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE probes SET status = ?, result_key = ?, error = ?, finished_at = ? WHERE id = ?").bind(b.status === "ok" ? "ok" : "error", key, b.error ?? null, now, probeId),
    c.env.DB.prepare("UPDATE jobs SET status = 'done', finished_at = ? WHERE id = ?").bind(now, job.id),
    c.env.DB.prepare("INSERT INTO submissions (job_id, submission_key, response_json, created_at) VALUES (?, ?, ?, ?)").bind(job.id, b.submission_key, JSON.stringify(resp), now),
  ]);
  c.executionCtx.waitUntil(notifyProbe(c.env, probeId));
  return c.json(resp);
});
