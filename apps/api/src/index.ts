import { Hono } from "hono";
import type { Env } from "./env.js";
import { userAuth, type AppVars } from "./auth.js";
import { userApi } from "./routes/user.js";
import { workerApi } from "./routes/worker.js";
import { tick } from "./jobs.js";
import { finalizeExpiredRun } from "./ingest.js";
import { completeHooks, markProbeFailed } from "./hooks.js";

export { SetupWorkflow } from "./ai/setup.js";

const app = new Hono<{ Bindings: Env; Variables: AppVars }>();

app.get("/api/health", (c) => c.json({ ok: true }));
app.use("/api/v1/*", userAuth);
app.route("/api/v1", userApi);
app.route("/worker/v1", workerApi);

/** 開発用：Cron を手動で起動（DEV_AUTH_BYPASS=1 のときのみ） */
app.post("/api/dev/tick", async (c) => {
  if (c.env.DEV_AUTH_BYPASS !== "1") return c.json({ error: "forbidden" }, 403);
  return c.json(await runTick(c.env));
});

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

async function runTick(env: Env) {
  const hooks = completeHooks(env);
  return tick(
    env,
    (runId) => finalizeExpiredRun(env, runId, hooks),
    (probeId, err) => markProbeFailed(env, probeId, err),
  );
}

export default {
  fetch: app.fetch,
  async scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runTick(env));
  },
} satisfies ExportedHandler<Env>;
