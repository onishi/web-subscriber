// 認証：利用者は Cloudflare Access JWT、クローラはワーカー別 Bearer トークン（権限を分離）
import type { Context, Next } from "hono";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./env.js";
import { nowIso, sha256 } from "./env.js";

export type AppVars = { userId: string; workerId: string };
type C = Context<{ Bindings: Env; Variables: AppVars }>;

const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

export async function userAuth(c: C, next: Next) {
  if (c.env.DEV_AUTH_BYPASS === "1") {
    c.set("userId", "dev");
    return next();
  }
  const team = c.env.ACCESS_TEAM_DOMAIN;
  const token = c.req.header("Cf-Access-Jwt-Assertion");
  if (!team || !c.env.ACCESS_AUD || !token) return c.json({ error: "unauthorized" }, 401);
  let jwks = jwksCache.get(team);
  if (!jwks) jwksCache.set(team, (jwks = createRemoteJWKSet(new URL(`${team}/cdn-cgi/access/certs`))));
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer: team, audience: c.env.ACCESS_AUD });
    c.set("userId", String(payload.email ?? payload.sub));
  } catch {
    return c.json({ error: "unauthorized" }, 401);
  }
  return next();
}

export function workerAuth(scope: string) {
  return async (c: C, next: Next) => {
    const h = c.req.header("Authorization") ?? "";
    const m = /^Bearer\s+(\S+)$/.exec(h);
    if (!m) return c.json({ error: "unauthorized" }, 401);
    const row = await c.env.DB.prepare("SELECT id, scopes, disabled FROM crawler_workers WHERE token_hash = ?").bind(await sha256(m[1])).first<{ id: string; scopes: string; disabled: number }>();
    if (!row || row.disabled) return c.json({ error: "unauthorized" }, 401);
    if (!row.scopes.split(",").includes(scope)) return c.json({ error: "forbidden", scope }, 403);
    c.set("workerId", row.id);
    c.executionCtx.waitUntil(c.env.DB.prepare("UPDATE crawler_workers SET last_seen_at = ? WHERE id = ?").bind(nowIso(), row.id).run());
    return next();
  };
}
