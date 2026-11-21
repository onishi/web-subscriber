import { Hono } from "hono";
import type { Env } from "./env.js";
import { userAuth, type AppVars } from "./auth.js";
import { userApi } from "./routes/user.js";
import { workerApi } from "./routes/worker.js";
import { tick } from "./jobs.js";
import { finalizeExpiredRun } from "./ingest.js";
import { completeHooks, markProbeFailed } from "./hooks.js";
import { processFieldExtractions } from "./fields.js";
import { notFound, publicPages } from "./public.js";
import { handleMcp } from "./mcp.js";

export { SetupWorkflow } from "./ai/setup.js";

const app = new Hono<{ Bindings: Env; Variables: AppVars }>();

app.get("/api/health", (c) => c.json({ ok: true }));
app.use("/api/v1/*", userAuth);
app.route("/api/v1", userApi);
app.route("/worker/v1", workerApi);
// セットの公開ページ。本番は PUBLIC_HOST へ転送し、PUBLIC_HOST 未設定（開発時）はここで返す
app.all("/p/*", async (c, next) => {
  if (!c.env.PUBLIC_HOST) return next();
  const u = new URL(c.req.url);
  return c.redirect(`https://${c.env.PUBLIC_HOST}${u.pathname.slice(2)}${u.search}`, 301);
});
app.route("/p", publicPages);

/** 開発用：Cron を手動で起動（DEV_AUTH_BYPASS=1 のときのみ） */
app.post("/api/dev/tick", async (c) => {
  if (c.env.DEV_AUTH_BYPASS !== "1") return c.json({ error: "forbidden" }, 403);
  return c.json(await runTick(c.env));
});

// MCP サーバー（AI クライアントから全機能を操作）。認証は個人アクセストークン。Cloudflare Access では /mcp を Bypass にしてある
app.all("/mcp", (c) => handleMcp(c.req.raw, c.env, c.executionCtx as ExecutionContext, (r) => Promise.resolve(app.fetch(r, c.env, c.executionCtx))));

app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

/** 公開ページ専用ホスト（radar）：公開ページ以外は返さない */
const radar = new Hono<{ Bindings: Env }>();
radar.get("/robots.txt", (c) => c.text("User-agent: *\nAllow: /\n"));
radar.route("/", publicPages);
radar.all("*", (c) => c.html(notFound(), 404));

async function runTick(env: Env) {
  const hooks = completeHooks(env);
  const r = await tick(
    env,
    (runId) => finalizeExpiredRun(env, runId, hooks),
    (probeId, err) => markProbeFailed(env, probeId, err),
  );
  // セットのカスタムフィールド：未抽出の item を少しずつ AI で抽出
  const fields = await processFieldExtractions(env, { limit: 24 }).catch((e) => ({ error: String(e) }));
  return { ...r, fields };
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    if (env.PUBLIC_HOST && new URL(req.url).hostname === env.PUBLIC_HOST) return radar.fetch(req, env, ctx);
    return app.fetch(req, env, ctx);
  },
  async scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runTick(env));
  },
} satisfies ExportedHandler<Env>;
