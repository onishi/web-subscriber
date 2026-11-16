// VPS 常駐プロセス：APIからジョブをリースし、クロール/プローブを実行して結果を送信する
import { CRAWLER_VERSION, type LeasedJob, type CompleteSubmission } from "@ws/shared";
import { settings } from "./settings.js";
import { lease, heartbeat, send, uploadArtifact, flushOutbox, outboxSize } from "./api.js";
import { crawl } from "./crawl.js";
import { ImageEnricher } from "./images.js";
import { DetailEnricher } from "./detail.js";
import { runProbe } from "./probe.js";
import { engineVersion, closeBrowser } from "./browser.js";
import { pruneHttpCache } from "./net.js";

let running = 0;
let stopping = false;

function log(...a: unknown[]) {
  console.log(new Date().toISOString(), ...a);
}

async function withHeartbeat<T>(job: LeasedJob, fn: () => Promise<T>): Promise<T> {
  const timer = setInterval(() => void heartbeat(job.job_id, job.lease_token), 60_000);
  try {
    return await fn();
  } finally {
    clearInterval(timer);
  }
}

async function handleCrawl(job: LeasedJob) {
  const runId = job.run_id!;
  const startedAt = new Date().toISOString();
  let pageNo = 0;
  const cfg = job.config!;
  const images = job.item_images
    ? new ImageEnricher(job.item_images, { minIntervalMs: cfg.politeness.min_interval_ms, respectRobots: cfg.politeness.respect_robots_txt })
    : undefined;
  const detail = job.detail && cfg.detail ? new DetailEnricher(cfg, job.detail) : undefined;
  const outcome = await crawl(cfg, {
    page: async (p) => {
      pageNo++;
      await send(`run:${runId}`, `/worker/v1/runs/${runId}/pages/${p.page.seq}`, {
        lease_token: job.lease_token,
        submission_key: `${job.job_id}:${job.attempt}:page:${p.page.seq}`,
        ...p,
      }).catch((e) => log(`[run ${runId}] page ${p.page.seq} deferred: ${(e as Error).message}`));
    },
    artifact: (name, data, ct) => uploadArtifact("runs", runId, name, data, ct),
  }, { images, detail });
  const body: CompleteSubmission = {
    lease_token: job.lease_token,
    submission_key: `${job.job_id}:${job.attempt}:complete`,
    traversal: outcome.traversal,
    end_reason: outcome.end_reason,
    extract_status: outcome.extract_status,
    error_stage: outcome.error_stage,
    error_detail: outcome.error_detail,
    pages_fetched: outcome.pages_fetched,
    actions_performed: outcome.actions_performed,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    worker_id: settings.workerId,
    crawler_version: CRAWLER_VERSION,
    engine_version: await engineVersion(),
    retryable: outcome.retryable,
    item_images: images?.stats(),
    detail: detail?.stats(),
  };
  await send(`run:${runId}`, `/worker/v1/runs/${runId}/complete`, body).catch((e) => log(`[run ${runId}] complete deferred: ${(e as Error).message}`));
  log(`[run ${runId}] ${outcome.traversal} ${outcome.end_reason} extract=${outcome.extract_status} pages=${pageNo}${detail ? ` detail=${detail.ok}/${detail.tried}` : ""}${images ? ` og_image=${images.found}/${images.tried}(${job.item_images!.mode})` : ""}${outcome.error_detail ? " err=" + outcome.error_detail : ""}`);
}

async function handleProbe(job: LeasedJob) {
  const probeId = job.probe_id!;
  let summary: unknown;
  let status: "ok" | "error" = "ok";
  let error: string | undefined;
  try {
    summary = await runProbe(job.probe!, (name, data, ct) => uploadArtifact("probes", probeId, name, data, ct));
  } catch (e) {
    status = "error";
    error = (e as Error).message;
  }
  await send(`probe:${probeId}`, `/worker/v1/probes/${probeId}/result`, {
    lease_token: job.lease_token,
    submission_key: `${job.job_id}:${job.attempt}:result`,
    status,
    error,
    summary: summary ?? null,
  }).catch((e) => log(`[probe ${probeId}] result deferred: ${(e as Error).message}`));
  log(`[probe ${probeId}] ${job.probe!.kind} ${status}${error ? " " + error : ""}`);
}

async function runJob(job: LeasedJob) {
  running++;
  try {
    await withHeartbeat(job, () => (job.kind === "crawl" ? handleCrawl(job) : handleProbe(job)));
  } catch (e) {
    log(`[job ${job.job_id}] crashed`, e);
  } finally {
    running--;
  }
}

async function loop() {
  log(`crawler ${CRAWLER_VERSION} worker=${settings.workerId} api=${settings.apiBase} http_cache=${settings.httpCache ? `source ${settings.httpCacheSourceTtlMs / 60000}m / link ${settings.httpCacheLinkTtlMs / 3600000}h` : "off"}`);
  let lastPrune = 0;
  while (!stopping) {
    try {
      if (outboxSize() > 0) await flushOutbox();
      if (Date.now() - lastPrune > 3600_000) {
        lastPrune = Date.now();
        const n = pruneHttpCache();
        if (n) log(`http cache: pruned ${n}`);
      }
      const free = settings.concurrency - running;
      if (free > 0) {
        const jobs = await lease(free);
        for (const j of jobs) {
          log(`leased ${j.kind} ${j.job_id} attempt=${j.attempt}`);
          void runJob(j);
        }
        if (jobs.length > 0) continue;
      }
    } catch (e) {
      log("poll error:", (e as Error).message);
    }
    await new Promise((r) => setTimeout(r, settings.pollIntervalMs));
  }
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    stopping = true;
    log(`stopping (${running} running)`);
    const t0 = Date.now();
    while (running > 0 && Date.now() - t0 < 60_000) await new Promise((r) => setTimeout(r, 500));
    await closeBrowser();
    process.exit(0);
  });
}

if (!settings.workerToken) {
  console.error("WS_WORKER_TOKEN is required");
  process.exit(1);
}
void loop();
