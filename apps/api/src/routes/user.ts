// 利用者向け API（docs/design.md §8）
import { Hono } from "hono";
import { parseConfig, identityScheme, hashScheme, schemeHash, type ChannelData, type ItemData, type SubscriptionConfig } from "@ws/shared";
import { type Env, newId, nowIso, json, scheduleMinute, nextRunAt } from "../env.js";
import { type AppVars } from "../auth.js";
import { enqueueCrawl, enqueueProbe, type SubRow } from "../jobs.js";
import { startSession } from "../ai/setup.js";

export const userApi = new Hono<{ Bindings: Env; Variables: AppVars }>();

userApi.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal", message: String(err) }, 500);
});

async function getSub(env: Env, id: string) {
  return env.DB.prepare("SELECT * FROM subscriptions WHERE id = ?").bind(id).first<SubRow>();
}

function subView(s: SubRow & Record<string, unknown>) {
  return {
    ...s,
    config_method: s.config_method ?? null,
    config_kind: s.config_kind ?? null,
  };
}

// ---- 購読先 ----
userApi.get("/subscriptions", async (c) => {
  const uid = c.get("userId");
  const rs = await c.env.DB.prepare(
    `SELECT s.*, json_extract(cv.config_json, '$.fetch.method') AS config_method, json_extract(cv.config_json, '$.source.kind') AS config_kind,
       json_extract(ch.data_json, '$.title.value') AS channel_title,
       json_extract(ch.data_json, '$.logo.url') AS channel_logo,
       (SELECT COUNT(*) FROM items i WHERE i.subscription_id = s.id AND i.is_baseline = 0 AND NOT EXISTS (SELECT 1 FROM reading_states r WHERE r.item_id = i.id AND r.user_id = ?)) AS unread_count,
       (SELECT COUNT(*) FROM items i WHERE i.subscription_id = s.id) AS item_count,
       (SELECT COUNT(*) FROM jobs j WHERE j.subscription_id = s.id AND j.kind = 'crawl' AND j.status IN ('queued','leased')) AS active_jobs,
       (SELECT status FROM setup_sessions ss WHERE ss.id = s.current_setup_session_id) AS setup_status,
       (SELECT COUNT(*) FROM config_versions d WHERE d.subscription_id = s.id AND d.state = 'draft') AS draft_count,
       (SELECT r.run_status || '|' || COALESCE(r.change_status,'') || '|' || COALESCE(r.end_reason,'') FROM crawl_runs r WHERE r.subscription_id = s.id AND r.finished_at IS NOT NULL ORDER BY r.finished_at DESC LIMIT 1) AS last_run
     FROM subscriptions s
     LEFT JOIN config_versions cv ON cv.id = s.active_config_version_id
     LEFT JOIN channels ch ON ch.subscription_id = s.id
     WHERE s.status != 'archived' ORDER BY s.created_at DESC`,
  )
    .bind(uid)
    .all<SubRow & Record<string, unknown>>();
  return c.json({ subscriptions: rs.results.map(subView) });
});

userApi.post("/subscriptions", async (c) => {
  const b = await c.req.json<{ url: string; title?: string; config?: unknown }>();
  let url: string;
  try {
    url = new URL(b.url).toString();
    if (!/^https?:$/.test(new URL(url).protocol)) throw new Error();
  } catch {
    return c.json({ error: "invalid_url" }, 400);
  }
  const id = newId();
  const now = nowIso();
  await c.env.DB.prepare(
    "INSERT INTO subscriptions (id, input_url, display_title, status, schedule_minute_of_day, timezone, created_at, updated_at) VALUES (?, ?, ?, 'setup', ?, ?, ?, ?)",
  )
    .bind(id, url, b.title ?? null, await scheduleMinute(id), c.env.DEFAULT_TIMEZONE || "Asia/Tokyo", now, now)
    .run();
  if (b.config) {
    const r = await createConfigVersion(c.env, id, b.config, "manual", null);
    if ("errors" in r) return c.json({ id, errors: r.errors }, 400);
    return c.json({ id, config_version_id: r.id }, 201);
  }
  const sid = await startSession(c.env, id, "setup", url);
  return c.json({ id, setup_session_id: sid }, 201);
});

userApi.get("/subscriptions/:id", async (c) => {
  const s = await getSub(c.env, c.req.param("id"));
  if (!s) return c.json({ error: "not_found" }, 404);
  const cv = s.active_config_version_id ? await c.env.DB.prepare("SELECT * FROM config_versions WHERE id = ?").bind(s.active_config_version_id).first() : null;
  const ch = await c.env.DB.prepare("SELECT data_json, updated_at FROM channels WHERE subscription_id = ?").bind(s.id).first<{ data_json: string; updated_at: string }>();
  const versions = await c.env.DB.prepare("SELECT id, version, state, origin, note, created_at, activated_at, validation_summary_json, setup_session_id FROM config_versions WHERE subscription_id = ? ORDER BY version DESC").bind(s.id).all();
  const session = s.current_setup_session_id ? await c.env.DB.prepare("SELECT id, kind, status, error, created_at FROM setup_sessions WHERE id = ?").bind(s.current_setup_session_id).first() : null;
  const activeJob = await c.env.DB.prepare("SELECT j.status, j.not_before, r.id AS run_id, r.trigger FROM jobs j JOIN crawl_runs r ON r.id = j.run_id WHERE j.subscription_id = ? AND j.kind='crawl' AND j.status IN ('queued','leased')").bind(s.id).first();
  return c.json({
    subscription: s,
    active_config: cv ? { ...cv, config: json(cv.config_json as string, null) } : null,
    channel: ch ? json<ChannelData | null>(ch.data_json, null) : null,
    versions: versions.results.map((v) => ({ ...v, validation_summary: json((v as { validation_summary_json: string }).validation_summary_json, null) })),
    current_session: session,
    active_job: activeJob,
  });
});

userApi.patch("/subscriptions/:id", async (c) => {
  const s = await getSub(c.env, c.req.param("id"));
  if (!s) return c.json({ error: "not_found" }, 404);
  const b = await c.req.json<{
    status?: "active" | "paused" | "archived";
    display_title?: string | null;
    schedule_minute_of_day?: number;
    schedule_interval_minutes?: number;
    /** null で未判定に戻す（次回の実行で再試行） */
    item_image_mode?: "og_image" | "off" | null;
  }>();
  const now = nowIso();
  if (b.status) {
    if (b.status === "active" && !s.active_config_version_id) return c.json({ error: "no_active_config" }, 400);
    const next = b.status === "active" ? nextRunAt(b.schedule_minute_of_day ?? s.schedule_minute_of_day, b.schedule_interval_minutes ?? s.schedule_interval_minutes, s.timezone) : null;
    await c.env.DB.prepare("UPDATE subscriptions SET status = ?, next_run_at = ?, updated_at = ? WHERE id = ?").bind(b.status, next, now, s.id).run();
    if (b.status !== "active") await c.env.DB.prepare("UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE subscription_id = ? AND kind = 'crawl' AND status = 'queued'").bind(now, s.id).run();
  }
  if (b.item_image_mode !== undefined) {
    if (b.item_image_mode !== null && b.item_image_mode !== "og_image" && b.item_image_mode !== "off") return c.json({ error: "bad_item_image_mode" }, 400);
    await c.env.DB.prepare("UPDATE subscriptions SET item_image_mode = ?, updated_at = ? WHERE id = ?").bind(b.item_image_mode, now, s.id).run();
    // 再試行時は見つからなかった item も確認し直す
    if (b.item_image_mode === null) await c.env.DB.prepare("UPDATE items SET image_checked_at = NULL WHERE subscription_id = ? AND image_url IS NULL").bind(s.id).run();
  }
  if (b.display_title !== undefined) await c.env.DB.prepare("UPDATE subscriptions SET display_title = ?, updated_at = ? WHERE id = ?").bind(b.display_title, now, s.id).run();
  if (b.schedule_minute_of_day !== undefined || b.schedule_interval_minutes !== undefined) {
    const m = Math.max(0, Math.min(1439, b.schedule_minute_of_day ?? s.schedule_minute_of_day));
    const iv = Math.max(60, b.schedule_interval_minutes ?? s.schedule_interval_minutes);
    await c.env.DB.prepare("UPDATE subscriptions SET schedule_minute_of_day = ?, schedule_interval_minutes = ?, next_run_at = CASE WHEN status = 'active' THEN ? ELSE next_run_at END, updated_at = ? WHERE id = ?")
      .bind(m, iv, nextRunAt(m, iv, s.timezone), now, s.id)
      .run();
  }
  return c.json({ subscription: await getSub(c.env, s.id) });
});

userApi.post("/subscriptions/:id/crawl", async (c) => {
  const s = await getSub(c.env, c.req.param("id"));
  if (!s) return c.json({ error: "not_found" }, 404);
  if (!s.active_config_version_id) return c.json({ error: "no_active_config" }, 400);
  const r = await enqueueCrawl(c.env, s, "manual");
  if (!r) return c.json({ error: "already_queued" }, 409);
  return c.json(r, 202);
});

userApi.post("/subscriptions/:id/repair", async (c) => {
  const s = await getSub(c.env, c.req.param("id"));
  if (!s) return c.json({ error: "not_found" }, 404);
  const running = await c.env.DB.prepare("SELECT id FROM setup_sessions WHERE subscription_id = ? AND status = 'running'").bind(s.id).first();
  if (running) return c.json({ error: "session_running" }, 409);
  const last = await c.env.DB.prepare("SELECT id FROM crawl_runs WHERE subscription_id = ? AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1").bind(s.id).first<{ id: string }>();
  const cv = s.active_config_version_id
    ? await c.env.DB.prepare("SELECT json_extract(config_json, '$.source.url') AS url FROM config_versions WHERE id = ?").bind(s.active_config_version_id).first<{ url: string }>()
    : null;
  const sid = await startSession(c.env, s.id, s.active_config_version_id ? "repair" : "setup", cv?.url ?? s.input_url, last?.id);
  return c.json({ setup_session_id: sid }, 201);
});

// ---- 設定バージョン ----
async function createConfigVersion(env: Env, subId: string, raw: unknown, origin: string, note: string | null): Promise<{ id: string } | { errors: string[] }> {
  const r = parseConfig(raw);
  if (!r.ok) return { errors: r.errors };
  const cfg = r.config;
  const last = await env.DB.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM config_versions WHERE subscription_id = ?").bind(subId).first<{ v: number }>();
  const parent = await env.DB.prepare("SELECT active_config_version_id FROM subscriptions WHERE id = ?").bind(subId).first<{ active_config_version_id: string | null }>();
  const id = newId();
  await env.DB.prepare(
    `INSERT INTO config_versions (id, subscription_id, version, state, config_json, config_hash, identity_scheme_hash, hash_scheme_hash, origin, parent_version_id, note, created_at)
     VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, subId, (last?.v ?? 0) + 1, JSON.stringify(cfg), await schemeHash(cfg), await schemeHash(identityScheme(cfg)), await schemeHash(hashScheme(cfg)), origin, parent?.active_config_version_id ?? null, note, nowIso())
    .run();
  return { id };
}

userApi.post("/subscriptions/:id/configs", async (c) => {
  const s = await getSub(c.env, c.req.param("id"));
  if (!s) return c.json({ error: "not_found" }, 404);
  const b = await c.req.json<{ config: unknown; note?: string }>();
  const r = await createConfigVersion(c.env, s.id, b.config, "manual", b.note ?? null);
  if ("errors" in r) return c.json({ errors: r.errors }, 400);
  return c.json(r, 201);
});

userApi.post("/configs/validate-schema", async (c) => {
  const r = parseConfig(await c.req.json());
  return c.json(r.ok ? { ok: true, config: r.config } : r);
});

userApi.get("/configs/:id", async (c) => {
  const cv = await c.env.DB.prepare("SELECT * FROM config_versions WHERE id = ?").bind(c.req.param("id")).first<Record<string, string>>();
  if (!cv) return c.json({ error: "not_found" }, 404);
  let report: unknown = null;
  if (cv.validation_report_key) report = await (await c.env.BLOBS.get(cv.validation_report_key))?.json();
  return c.json({ ...cv, config: json(cv.config_json, null), validation_summary: json(cv.validation_summary_json, null), report });
});

/** 設定を VPS で検証実行（http/browser 比較）。結果は GET /probes/:id */
userApi.post("/configs/:id/validate", async (c) => {
  const cv = await c.env.DB.prepare("SELECT id, config_json FROM config_versions WHERE id = ?").bind(c.req.param("id")).first<{ id: string; config_json: string }>();
  if (!cv) return c.json({ error: "not_found" }, 404);
  const cfg = JSON.parse(cv.config_json) as SubscriptionConfig;
  const methods: ("http" | "browser")[] = cfg.source.kind === "feed" ? ["http"] : [cfg.fetch.method, cfg.fetch.method === "http" ? "browser" : "http"];
  const pid = await enqueueProbe(c.env, `cv:${cv.id}`, { kind: "extract", config: cfg, max_pages: 3, methods });
  return c.json({ probe_id: pid }, 202);
});

userApi.post("/configs/:id/activate", async (c) => {
  const cv = await c.env.DB.prepare("SELECT * FROM config_versions WHERE id = ?").bind(c.req.param("id")).first<{ id: string; subscription_id: string; state: string }>();
  if (!cv) return c.json({ error: "not_found" }, 404);
  if (cv.state === "active") return c.json({ ok: true });
  const s = (await getSub(c.env, cv.subscription_id))!;
  const now = nowIso();
  const status = s.status === "setup" ? "active" : s.status;
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE config_versions SET state = 'superseded' WHERE subscription_id = ? AND state = 'active'").bind(s.id),
    c.env.DB.prepare("UPDATE config_versions SET state = 'active', activated_at = ? WHERE id = ?").bind(now, cv.id),
    c.env.DB.prepare("UPDATE subscriptions SET active_config_version_id = ?, status = ?, next_run_at = ?, consecutive_extract_failures = 0, updated_at = ? WHERE id = ?").bind(
      cv.id,
      status,
      status === "active" ? nextRunAt(s.schedule_minute_of_day, s.schedule_interval_minutes, s.timezone) : s.next_run_at,
      now,
      s.id,
    ),
    // 旧設定の未実行ジョブは取り消し、新設定で実行する
    c.env.DB.prepare("UPDATE jobs SET status = 'cancelled', finished_at = ? WHERE subscription_id = ? AND kind = 'crawl' AND status = 'queued'").bind(now, s.id),
  ]);
  const fresh = (await getSub(c.env, s.id))!;
  const run = status === "active" ? await enqueueCrawl(c.env, fresh, "activation") : null;
  return c.json({ ok: true, run });
});

userApi.post("/configs/:id/reject", async (c) => {
  await c.env.DB.prepare("UPDATE config_versions SET state = 'rejected' WHERE id = ? AND state = 'draft'").bind(c.req.param("id")).run();
  return c.json({ ok: true });
});

userApi.get("/probes/:id", async (c) => {
  const p = await c.env.DB.prepare("SELECT * FROM probes WHERE id = ?").bind(c.req.param("id")).first<{ id: string; status: string; error: string | null; result_key: string | null; session_id: string | null; kind: string }>();
  if (!p) return c.json({ error: "not_found" }, 404);
  let summary: unknown = null;
  let comparison: unknown = null;
  if (p.result_key) summary = await (await c.env.BLOBS.get(p.result_key))?.json();
  if (summary && p.session_id?.startsWith("cv:")) {
    // 既存itemとの照合（ルール変更前後の比較）
    const cv = await c.env.DB.prepare("SELECT subscription_id, identity_scheme_hash, config_json FROM config_versions WHERE id = ?").bind(p.session_id.slice(3)).first<{ subscription_id: string; identity_scheme_hash: string; config_json: string }>();
    const m = (JSON.parse(cv!.config_json) as SubscriptionConfig).fetch.method;
    const keys = ((summary as Record<string, { all_keys?: string[] }>)[m]?.all_keys ?? []).slice(0, 300);
    let matched = 0;
    for (let i = 0; i < keys.length; i += 50) {
      const ch = keys.slice(i, i + 50);
      const r = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM items WHERE subscription_id = ? AND identity_scheme = ? AND identity_key IN (${ch.map(() => "?").join(",")})`)
        .bind(cv!.subscription_id, cv!.identity_scheme_hash, ...ch)
        .first<{ n: number }>();
      matched += r?.n ?? 0;
    }
    const existing = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM items WHERE subscription_id = ?").bind(cv!.subscription_id).first<{ n: number }>();
    comparison = { candidate_items: keys.length, matched_existing: matched, would_be_new: keys.length - matched, existing_items: existing?.n ?? 0 };
  }
  return c.json({ ...p, summary, comparison });
});

// ---- AI セッション ----
userApi.get("/setup-sessions/:id", async (c) => {
  const s = await c.env.DB.prepare("SELECT * FROM setup_sessions WHERE id = ?").bind(c.req.param("id")).first<Record<string, string>>();
  if (!s) return c.json({ error: "not_found" }, 404);
  let report: unknown = null;
  if (s.report_key) report = await (await c.env.BLOBS.get(s.report_key))?.json();
  const cv = s.result_config_version_id ? await c.env.DB.prepare("SELECT id, version, state, config_json FROM config_versions WHERE id = ?").bind(s.result_config_version_id).first<Record<string, string>>() : null;
  return c.json({ ...s, progress: json(s.progress_json, []), report, config_version: cv ? { ...cv, config: json(cv.config_json, null) } : null });
});

// ---- クロール履歴 ----
userApi.get("/subscriptions/:id/runs", async (c) => {
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const rs = await c.env.DB.prepare(
    `SELECT r.*, cv.version AS config_version, (SELECT http_status FROM crawl_pages p WHERE p.run_id = r.id ORDER BY seq LIMIT 1) AS first_http_status
     FROM crawl_runs r LEFT JOIN config_versions cv ON cv.id = r.config_version_id WHERE r.subscription_id = ? ORDER BY r.queued_at DESC LIMIT ?`,
  )
    .bind(c.req.param("id"), limit)
    .all();
  return c.json({ runs: rs.results });
});

userApi.get("/runs/:id", async (c) => {
  const r = await c.env.DB.prepare("SELECT r.*, cv.version AS config_version FROM crawl_runs r LEFT JOIN config_versions cv ON cv.id = r.config_version_id WHERE r.id = ?").bind(c.req.param("id")).first();
  if (!r) return c.json({ error: "not_found" }, 404);
  const pages = await c.env.DB.prepare("SELECT * FROM crawl_pages WHERE run_id = ? ORDER BY seq").bind(c.req.param("id")).all<Record<string, string>>();
  return c.json({ run: r, pages: pages.results.map((p) => ({ ...p, field_failures: json(p.field_failures_json, null), timings: json(p.timings_json, null) })) });
});

userApi.get("/artifacts/*", async (c) => {
  const key = decodeURIComponent(c.req.path.replace(/^.*\/artifacts\//, ""));
  if (!/^(r30|r90|latest|sessions)\//.test(key)) return c.json({ error: "forbidden" }, 403);
  const o = await c.env.BLOBS.get(key);
  if (!o) return c.json({ error: "not_found" }, 404);
  const headers = new Headers();
  o.writeHttpMetadata(headers);
  if (key.endsWith(".gz")) {
    const ds = o.body.pipeThrough(new DecompressionStream("gzip"));
    headers.set("content-type", key.endsWith(".xml.gz") ? "text/plain; charset=utf-8" : "text/plain; charset=utf-8");
    return new Response(ds, { headers });
  }
  return new Response(o.body, { headers });
});

// ---- item ----
userApi.get("/items", async (c) => {
  const uid = c.get("userId");
  const view = c.req.query("view") ?? "new"; // new（基準データも含め検出・更新の新しい順）| all | baseline | updated
  const sub = c.req.query("subscription_id");
  const unread = c.req.query("unread") === "1";
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);
  const where: string[] = [];
  const args: unknown[] = [uid];
  if (sub) {
    where.push("i.subscription_id = ?");
    args.push(sub);
  }
  if (view === "baseline") where.push("i.is_baseline = 1");
  if (view === "updated") where.push("i.last_changed_at IS NOT NULL");
  if (unread) where.push("rs.read_at IS NULL AND i.is_baseline = 0");
  const order = view === "updated" ? "i.last_changed_at DESC" : view === "new" ? "COALESCE(i.last_changed_at, i.first_seen_at) DESC, i.id DESC" : "i.first_seen_at DESC, COALESCE(i.published_sort, '') DESC, i.id DESC";
  args.push(limit + 1, offset);
  const rs = await c.env.DB.prepare(
    `SELECT i.id, i.subscription_id, i.title_text, i.primary_link, i.published_sort, i.is_baseline, i.image_url, i.first_seen_at, i.last_seen_at, i.last_changed_at, i.revision_count,
       json_extract(i.data_json, '$.summary.value') AS summary, json_extract(i.data_json, '$.summary.type') AS summary_type,
       json_extract(i.data_json, '$.published_at') AS published_at, json_extract(i.data_json, '$.updated_at') AS updated_at,
       COALESCE(s.display_title, json_extract(ch.data_json, '$.title.value'), s.input_url) AS subscription_title,
       rs.read_at
     FROM items i JOIN subscriptions s ON s.id = i.subscription_id LEFT JOIN channels ch ON ch.subscription_id = i.subscription_id
     LEFT JOIN reading_states rs ON rs.item_id = i.id AND rs.user_id = ?
     ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${order} LIMIT ? OFFSET ?`,
  )
    .bind(...args)
    .all<Record<string, unknown>>();
  const items = rs.results.slice(0, limit).map((r) => ({
    ...r,
    published_at: json(r.published_at as string, null),
    updated_at: json(r.updated_at as string, null),
    // 基準データ（初回取得分）は未読にしない
    is_read: !!r.read_at || !!r.is_baseline,
    // 既読後に内容が更新された／更新済みitem：「更新」印
    updated_mark: !!r.last_changed_at && (!r.read_at || String(r.last_changed_at) > String(r.read_at)),
  }));
  return c.json({ items, has_more: rs.results.length > limit, next_offset: offset + limit });
});

userApi.get("/items/:id", async (c) => {
  const uid = c.get("userId");
  const it = await c.env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(c.req.param("id")).first<Record<string, string>>();
  if (!it) return c.json({ error: "not_found" }, 404);
  const data = JSON.parse(it.data_json) as ItemData;
  const ch = await c.env.DB.prepare("SELECT data_json FROM channels WHERE subscription_id = ?").bind(it.subscription_id).first<{ data_json: string }>();
  const channel = ch ? (JSON.parse(ch.data_json) as ChannelData) : null;
  // 明示値と有効値（継承）を区別して返す
  const inherit = <T>(explicit: T | undefined | null, fromChannel: T | undefined | null, empty: (v: T) => boolean) =>
    explicit != null && !empty(explicit) ? { explicit, effective: explicit, from: "item" } : fromChannel != null && !empty(fromChannel) ? { explicit: null, effective: fromChannel, from: "channel" } : { explicit: null, effective: null };
  const isEmptyArr = (v: unknown) => Array.isArray(v) && v.length === 0;
  const effective = {
    authors: inherit(data.authors, data.source?.authors?.length ? data.source.authors : channel?.authors, isEmptyArr),
    rights: inherit(data.rights, data.source?.rights ?? channel?.rights, () => false),
    language: inherit(data.language ?? (data.content?.kind === "inline" ? data.content.lang : undefined), channel?.language, () => false),
  };
  const revisions = await c.env.DB.prepare("SELECT id, run_id, change_kind, created_at, data_json FROM item_revisions WHERE item_id = ? ORDER BY created_at DESC LIMIT 20").bind(it.id).all<Record<string, string>>();
  const rs = await c.env.DB.prepare("SELECT read_at FROM reading_states WHERE user_id = ? AND item_id = ?").bind(uid, it.id).first<{ read_at: string }>();
  const { data_json: _d, ...meta } = it;
  return c.json({ ...meta, data, effective, read_at: rs?.read_at ?? null, revisions: revisions.results.map((r) => ({ ...r, data: json(r.data_json, null), data_json: undefined })) });
});

userApi.put("/items/:id/read", async (c) => {
  await c.env.DB.prepare("INSERT INTO reading_states (user_id, item_id, read_at) VALUES (?, ?, ?) ON CONFLICT(user_id, item_id) DO UPDATE SET read_at = excluded.read_at").bind(c.get("userId"), c.req.param("id"), nowIso()).run();
  return c.json({ ok: true });
});
userApi.delete("/items/:id/read", async (c) => {
  await c.env.DB.prepare("DELETE FROM reading_states WHERE user_id = ? AND item_id = ?").bind(c.get("userId"), c.req.param("id")).run();
  return c.json({ ok: true });
});
userApi.post("/items/mark-read", async (c) => {
  const b = await c.req.json<{ subscription_id?: string; item_ids?: string[] }>();
  const now = nowIso();
  if (b.item_ids?.length) {
    await c.env.DB.batch(
      b.item_ids.slice(0, 500).map((id) =>
        c.env.DB.prepare("INSERT INTO reading_states (user_id, item_id, read_at) VALUES (?, ?, ?) ON CONFLICT(user_id, item_id) DO UPDATE SET read_at = excluded.read_at").bind(c.get("userId"), id, now),
      ),
    );
  } else {
    await c.env.DB.prepare(
      `INSERT INTO reading_states (user_id, item_id, read_at) SELECT ?, i.id, ? FROM items i WHERE i.is_baseline = 0 ${b.subscription_id ? "AND i.subscription_id = ?" : ""}
       ON CONFLICT(user_id, item_id) DO UPDATE SET read_at = excluded.read_at`,
    )
      .bind(...[c.get("userId"), now, ...(b.subscription_id ? [b.subscription_id] : [])])
      .run();
  }
  return c.json({ ok: true });
});
