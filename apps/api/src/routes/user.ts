// 利用者向け API（docs/design.md §8）
import { Hono } from "hono";
import { parseConfig, identityScheme, hashScheme, schemeHash, mergeDetail, type ChannelData, type ItemData, type SubscriptionConfig } from "@ws/shared";
import { type Env, newId, nowIso, json, scheduleMinute, nextRunAt } from "../env.js";
import { type AppVars } from "../auth.js";
import { enqueueCrawl, enqueueProbe, type SubRow } from "../jobs.js";
import { startSession } from "../ai/setup.js";
import { SLUG_RE, type PublicOptions } from "../public.js";
import { FIELD_KEY_RE, FIELD_TYPES, buildFieldQuery, displayValue, loadFields, processFieldExtractions, refreshFieldsHash, setManualValues, revertManualValues, type FieldType, type SetField } from "../fields.js";

export const userApi = new Hono<{ Bindings: Env; Variables: AppVars }>();

userApi.onError((err, c) => {
  console.error(err);
  return c.json({ error: "internal", message: String(err) }, 500);
});

async function getSub(env: Env, id: string) {
  return env.DB.prepare("SELECT * FROM subscriptions WHERE id = ?").bind(id).first<SubRow>();
}

function subView(s: SubRow & Record<string, unknown>) {
  const { set_ids_json, ...rest } = s;
  return {
    ...rest,
    set_ids: json<string[]>(set_ids_json as string | null, []),
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
       (SELECT json_group_array(m.set_id) FROM set_members m WHERE m.subscription_id = s.id) AS set_ids_json,
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
    set_ids: (await c.env.DB.prepare("SELECT set_id FROM set_members WHERE subscription_id = ?").bind(s.id).all<{ set_id: string }>()).results.map((r) => r.set_id),
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
  if (b.display_title !== undefined) {
    // 空なら表示名を外して、ソースのタイトルに戻す（ソースのタイトル自体は channels に残っている）
    const t = typeof b.display_title === "string" ? b.display_title.replace(/\s+/g, " ").trim().slice(0, 120) : "";
    await c.env.DB.prepare("UPDATE subscriptions SET display_title = ?, updated_at = ? WHERE id = ?").bind(t || null, now, s.id).run();
  }
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

/** リンク先（詳細ページ）の取得ルールを AI で作る（現行設定に detail を足した設定案を作成） */
userApi.post("/subscriptions/:id/detail-setup", async (c) => {
  const s = await getSub(c.env, c.req.param("id"));
  if (!s) return c.json({ error: "not_found" }, 404);
  if (!s.active_config_version_id) return c.json({ error: "no_active_config" }, 400);
  if (!c.env.GEMINI_API_KEY) return c.json({ error: "ai_not_configured" }, 400);
  const running = await c.env.DB.prepare("SELECT id FROM setup_sessions WHERE subscription_id = ? AND status = 'running'").bind(s.id).first();
  if (running) return c.json({ error: "session_running" }, 409);
  const cv = await c.env.DB.prepare("SELECT json_extract(config_json, '$.source.url') AS url FROM config_versions WHERE id = ?").bind(s.active_config_version_id).first<{ url: string }>();
  const sid = await startSession(c.env, s.id, "detail", cv?.url ?? s.input_url);
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
  const setId = c.req.query("set_id");
  const unread = c.req.query("unread") === "1";
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 200);
  const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);
  const where: string[] = [];
  const args: unknown[] = [uid];
  if (sub) {
    where.push("i.subscription_id = ?");
    args.push(sub);
  }
  if (setId) {
    where.push("i.subscription_id IN (SELECT subscription_id FROM set_members WHERE set_id = ?)");
    args.push(setId);
  }
  if (view === "baseline") where.push("i.is_baseline = 1");
  if (view === "updated") where.push("i.last_changed_at IS NOT NULL");
  if (unread) where.push("rs.read_at IS NULL AND i.is_baseline = 0");
  let order = view === "updated" ? "i.last_changed_at DESC" : view === "new" ? "COALESCE(i.last_changed_at, i.first_seen_at) DESC, i.id DESC" : "i.first_seen_at DESC, COALESCE(i.published_sort, '') DESC, i.id DESC";
  // セットのカスタムフィールドによる絞り込み・並べ替え
  const fields = setId ? await loadFields(c.env, setId) : [];
  if (setId) {
    const fq = buildFieldQuery(fields, new URL(c.req.url).searchParams);
    if ("error" in fq) return c.json({ error: fq.error }, 400);
    where.push(...fq.where);
    args.push(...fq.args);
    if (fq.order) {
      order = `${fq.order}, ${order}`;
      args.push(...fq.orderArgs);
    }
  }
  args.push(limit + 1, offset);
  const rs = await c.env.DB.prepare(
    `SELECT i.id, i.subscription_id, i.title_text, i.primary_link, i.published_sort, i.is_baseline, i.image_url, i.first_seen_at, i.last_seen_at, i.last_changed_at, i.revision_count,
       COALESCE(json_extract(i.detail_json, '$.summary.value'), json_extract(i.data_json, '$.summary.value')) AS summary,
       CASE WHEN json_extract(i.detail_json, '$.summary.value') IS NOT NULL THEN json_extract(i.detail_json, '$.summary.type') ELSE json_extract(i.data_json, '$.summary.type') END AS summary_type,
       json_extract(i.data_json, '$.published_at') AS published_at, json_extract(i.data_json, '$.updated_at') AS updated_at,
       COALESCE(s.display_title, json_extract(ch.data_json, '$.title.value'), s.input_url) AS subscription_title,
       rs.read_at
     FROM items i JOIN subscriptions s ON s.id = i.subscription_id LEFT JOIN channels ch ON ch.subscription_id = i.subscription_id
     LEFT JOIN reading_states rs ON rs.item_id = i.id AND rs.user_id = ?
     ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY ${order} LIMIT ? OFFSET ?`,
  )
    .bind(...args)
    .all<Record<string, unknown>>();
  const items: Record<string, unknown>[] = rs.results.slice(0, limit).map((r) => ({
    ...r,
    published_at: json(r.published_at as string, null),
    updated_at: json(r.updated_at as string, null),
    // 基準データ（初回取得分）は未読にしない
    is_read: !!r.read_at || !!r.is_baseline,
    // 既読後に内容が更新された／更新済みitem：「更新」印
    updated_mark: !!r.last_changed_at && (!r.read_at || String(r.last_changed_at) > String(r.read_at)),
  }));
  // セット表示ではカスタムフィールドの値を付ける
  if (setId && fields.length && items.length) {
    const vals = await c.env.DB.prepare(`SELECT item_id, field_id, ord, value_text, value_num, value_date FROM item_field_values WHERE set_id = ? AND item_id IN (${items.map(() => "?").join(",")}) ORDER BY ord`)
      .bind(setId, ...items.map((i) => i.id))
      .all<{ item_id: string; field_id: string; ord: number; value_text: string | null; value_num: number | null; value_date: string | null }>();
    const byId = new Map(fields.map((f) => [f.id, f]));
    const locks = await c.env.DB.prepare(`SELECT item_id, field_id FROM item_field_locks WHERE set_id = ? AND item_id IN (${items.map(() => "?").join(",")})`)
      .bind(setId, ...items.map((i) => i.id))
      .all<{ item_id: string; field_id: string }>();
    const manual = new Map<string, string[]>();
    for (const l of locks.results) {
      const f = byId.get(l.field_id);
      if (f) manual.set(l.item_id, [...(manual.get(l.item_id) ?? []), f.key]);
    }
    const per = new Map<string, Record<string, unknown[]>>();
    for (const v of vals.results) {
      const f = byId.get(v.field_id);
      if (!f) continue;
      const m = per.get(v.item_id) ?? {};
      (m[f.key] ??= []).push(displayValue(f.type, v));
      per.set(v.item_id, m);
    }
    return c.json({ items: items.map((i) => ({ ...i, fields: per.get(i.id as string) ?? {}, fields_manual: manual.get(i.id as string) ?? [] })), has_more: rs.results.length > limit, next_offset: offset + limit });
  }
  return c.json({ items, has_more: rs.results.length > limit, next_offset: offset + limit });
});

userApi.get("/items/:id", async (c) => {
  const uid = c.get("userId");
  const it = await c.env.DB.prepare("SELECT * FROM items WHERE id = ?").bind(c.req.param("id")).first<Record<string, string>>();
  if (!it) return c.json({ error: "not_found" }, 404);
  // 一覧の値に詳細ページの値を重ねたものを表示用の data とする（元の一覧の値は list_data）
  const listData = JSON.parse(it.data_json) as ItemData;
  const detailData = it.detail_json ? (JSON.parse(it.detail_json) as ItemData) : null;
  const data = mergeDetail(listData, detailData);
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
  const customFields = await itemCustomFields(c.env, it.id, it.subscription_id);
  const { data_json: _d, detail_json: _dj, ...meta } = it;
  return c.json({ ...meta, custom_fields: customFields, data, list_data: detailData ? listData : undefined, detail_data: detailData, effective, read_at: rs?.read_at ?? null, revisions: revisions.results.map((r) => ({ ...r, data: json(r.data_json, null), data_json: undefined })) });
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
  const b = await c.req.json<{ subscription_id?: string; set_id?: string; item_ids?: string[] }>();
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
         ${b.set_id ? "AND i.subscription_id IN (SELECT subscription_id FROM set_members WHERE set_id = ?)" : ""}
       ON CONFLICT(user_id, item_id) DO UPDATE SET read_at = excluded.read_at`,
    )
      .bind(...[c.get("userId"), now, ...(b.subscription_id ? [b.subscription_id] : []), ...(b.set_id ? [b.set_id] : [])])
      .run();
  }
  return c.json({ ok: true });
});

// ---- セット（複数の購読先をまとめたもの） ----
const setName = (v: unknown) => (typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, 60) : "");

async function listSets(env: Env, uid: string) {
  const rs = await env.DB.prepare(
    `SELECT st.id, st.name, st.position, st.created_at, st.updated_at,
       (SELECT COUNT(*) FROM set_members m JOIN subscriptions s ON s.id = m.subscription_id WHERE m.set_id = st.id AND s.status != 'archived') AS member_count,
       (SELECT COUNT(*) FROM items i WHERE i.is_baseline = 0 AND i.subscription_id IN (SELECT subscription_id FROM set_members WHERE set_id = st.id)
          AND NOT EXISTS (SELECT 1 FROM reading_states r WHERE r.item_id = i.id AND r.user_id = ?)) AS unread_count
     FROM sets st ORDER BY st.position, st.created_at`,
  )
    .bind(uid)
    .all<{ id: string; name: string; position: number; member_count: number; unread_count: number }>();
  return rs.results;
}

userApi.get("/sets", async (c) => c.json({ sets: await listSets(c.env, c.get("userId")) }));

userApi.post("/sets", async (c) => {
  const b = await c.req.json<{ name?: string; subscription_ids?: string[] }>();
  const name = setName(b.name);
  if (!name) return c.json({ error: "name_required" }, 400);
  if (await c.env.DB.prepare("SELECT 1 FROM sets WHERE name = ?").bind(name).first()) return c.json({ error: "name_taken" }, 409);
  const id = newId();
  const now = nowIso();
  const pos = await c.env.DB.prepare("SELECT COALESCE(MAX(position), -1) + 1 AS p FROM sets").first<{ p: number }>();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO sets (id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").bind(id, name, pos?.p ?? 0, now, now),
    ...(b.subscription_ids ?? []).slice(0, 500).map((sid) => c.env.DB.prepare("INSERT OR IGNORE INTO set_members (set_id, subscription_id, added_at) SELECT ?, id, ? FROM subscriptions WHERE id = ?").bind(id, now, sid)),
  ]);
  return c.json({ set: { id, name } }, 201);
});

userApi.get("/sets/:id", async (c) => {
  const st = await c.env.DB.prepare("SELECT * FROM sets WHERE id = ?").bind(c.req.param("id")).first();
  if (!st) return c.json({ error: "not_found" }, 404);
  const members = await c.env.DB.prepare(
    `SELECT s.id, s.input_url, s.display_title, s.status, s.health, json_extract(ch.data_json, '$.title.value') AS channel_title, json_extract(ch.data_json, '$.logo.url') AS channel_logo
     FROM set_members m JOIN subscriptions s ON s.id = m.subscription_id LEFT JOIN channels ch ON ch.subscription_id = s.id
     WHERE m.set_id = ? AND s.status != 'archived' ORDER BY m.added_at`,
  )
    .bind(st.id)
    .all();
  const fields = await loadFields(c.env, st.id as string);
  const status = await c.env.DB.prepare(
    `SELECT COUNT(*) AS total,
       SUM(CASE WHEN e.status = 'ok' AND e.schema_hash = ? THEN 1 ELSE 0 END) AS done,
       SUM(CASE WHEN e.status = 'error' AND e.schema_hash = ? THEN 1 ELSE 0 END) AS errors
     FROM items i JOIN set_members m ON m.subscription_id = i.subscription_id AND m.set_id = ?
     LEFT JOIN item_field_extractions e ON e.item_id = i.id AND e.set_id = m.set_id`,
  )
    .bind(st.fields_hash ?? "", st.fields_hash ?? "", st.id)
    .first<{ total: number; done: number; errors: number }>();
  const public_base_url = c.env.PUBLIC_HOST ? `https://${c.env.PUBLIC_HOST}/` : `${new URL(c.req.url).origin}/p/`;
  return c.json({ set: { ...st, public_base_url }, members: members.results, fields, extraction: { total: status?.total ?? 0, done: status?.done ?? 0, errors: status?.errors ?? 0, ai: !!c.env.GEMINI_API_KEY } });
});

userApi.patch("/sets/:id", async (c) => {
  const id = c.req.param("id");
  const b = await c.req.json<{ name?: string; position?: number }>();
  if (!(await c.env.DB.prepare("SELECT 1 FROM sets WHERE id = ?").bind(id).first())) return c.json({ error: "not_found" }, 404);
  const now = nowIso();
  if (b.name !== undefined) {
    const name = setName(b.name);
    if (!name) return c.json({ error: "name_required" }, 400);
    if (await c.env.DB.prepare("SELECT 1 FROM sets WHERE name = ? AND id != ?").bind(name, id).first()) return c.json({ error: "name_taken" }, 409);
    await c.env.DB.prepare("UPDATE sets SET name = ?, updated_at = ? WHERE id = ?").bind(name, now, id).run();
  }
  if (typeof b.position === "number") await c.env.DB.prepare("UPDATE sets SET position = ?, updated_at = ? WHERE id = ?").bind(Math.trunc(b.position), now, id).run();
  return c.json({ ok: true });
});

/** セットを削除（購読先・item はそのまま） */
userApi.delete("/sets/:id", async (c) => {
  const id = c.req.param("id");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM item_field_values WHERE set_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM item_field_extractions WHERE set_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM item_field_locks WHERE set_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM set_fields WHERE set_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM set_members WHERE set_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM sets WHERE id = ?").bind(id),
  ]);
  return c.json({ ok: true });
});

userApi.put("/sets/:id/members/:subId", async (c) => {
  const { id, subId } = c.req.param();
  if (!(await c.env.DB.prepare("SELECT 1 FROM sets WHERE id = ?").bind(id).first())) return c.json({ error: "not_found" }, 404);
  if (!(await getSub(c.env, subId))) return c.json({ error: "subscription_not_found" }, 404);
  await c.env.DB.prepare("INSERT OR IGNORE INTO set_members (set_id, subscription_id, added_at) VALUES (?, ?, ?)").bind(id, subId, nowIso()).run();
  return c.json({ ok: true });
});

userApi.delete("/sets/:id/members/:subId", async (c) => {
  const { id, subId } = c.req.param();
  const ofSub = "SELECT id FROM items WHERE subscription_id = ?";
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM set_members WHERE set_id = ? AND subscription_id = ?").bind(id, subId),
    c.env.DB.prepare(`DELETE FROM item_field_values WHERE set_id = ? AND item_id IN (${ofSub})`).bind(id, subId),
    c.env.DB.prepare(`DELETE FROM item_field_extractions WHERE set_id = ? AND item_id IN (${ofSub})`).bind(id, subId),
    c.env.DB.prepare(`DELETE FROM item_field_locks WHERE set_id = ? AND item_id IN (${ofSub})`).bind(id, subId),
  ]);
  return c.json({ ok: true });
});

// ---- セットのカスタムフィールド ----
function fieldInput(b: Record<string, unknown>, partial: boolean): { label?: string; key?: string; type?: FieldType; description?: string } | { error: string } {
  const out: { label?: string; key?: string; type?: FieldType; description?: string } = {};
  if (b.label !== undefined || !partial) {
    const label = typeof b.label === "string" ? b.label.trim().slice(0, 40) : "";
    if (!label) return { error: "label_required" };
    out.label = label;
  }
  if (b.key !== undefined && b.key !== "") {
    if (typeof b.key !== "string" || !FIELD_KEY_RE.test(b.key)) return { error: "bad_key" };
    out.key = b.key;
  }
  if (b.type !== undefined || !partial) {
    if (!(FIELD_TYPES as readonly unknown[]).includes(b.type)) return { error: "bad_type" };
    out.type = b.type as FieldType;
  }
  if (b.description !== undefined) out.description = typeof b.description === "string" ? b.description.trim().slice(0, 500) : "";
  return out;
}

userApi.post("/sets/:id/fields", async (c) => {
  const setId = c.req.param("id");
  if (!(await c.env.DB.prepare("SELECT 1 FROM sets WHERE id = ?").bind(setId).first())) return c.json({ error: "not_found" }, 404);
  const f = fieldInput(await c.req.json(), false);
  if ("error" in f) return c.json(f, 400);
  const existing = await loadFields(c.env, setId);
  if (existing.length >= 20) return c.json({ error: "too_many_fields" }, 400);
  let key = f.key;
  if (!key) for (let n = existing.length + 1; !key || existing.some((e) => e.key === key); n++) key = `field_${n}`;
  if (existing.some((e) => e.key === key)) return c.json({ error: "key_taken" }, 409);
  const id = newId();
  const now = nowIso();
  await c.env.DB.prepare("INSERT INTO set_fields (id, set_id, key, label, type, description, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, setId, key, f.label, f.type, f.description ?? "", existing.length, now, now)
    .run();
  await refreshFieldsHash(c.env, setId);
  return c.json({ field: { id, key } }, 201);
});

userApi.patch("/sets/:id/fields/:fieldId", async (c) => {
  const { id: setId, fieldId } = c.req.param();
  const cur = await c.env.DB.prepare("SELECT * FROM set_fields WHERE id = ? AND set_id = ?").bind(fieldId, setId).first<Record<string, unknown>>();
  if (!cur) return c.json({ error: "not_found" }, 404);
  const f = fieldInput(await c.req.json(), true);
  if ("error" in f) return c.json(f, 400);
  if (f.key && f.key !== cur.key && (await c.env.DB.prepare("SELECT 1 FROM set_fields WHERE set_id = ? AND key = ?").bind(setId, f.key).first())) return c.json({ error: "key_taken" }, 409);
  const stmts = [
    c.env.DB.prepare("UPDATE set_fields SET label = ?, key = ?, type = ?, description = ?, updated_at = ? WHERE id = ?").bind(
      f.label ?? cur.label,
      f.key ?? cur.key,
      f.type ?? cur.type,
      f.description ?? cur.description,
      nowIso(),
      fieldId,
    ),
  ];
  // 型が変わったら保存済みの値は使えない
  if (f.type && f.type !== cur.type)
    stmts.push(c.env.DB.prepare("DELETE FROM item_field_values WHERE field_id = ?").bind(fieldId), c.env.DB.prepare("DELETE FROM item_field_locks WHERE field_id = ?").bind(fieldId));
  await c.env.DB.batch(stmts);
  await refreshFieldsHash(c.env, setId);
  return c.json({ ok: true });
});

userApi.delete("/sets/:id/fields/:fieldId", async (c) => {
  const { id: setId, fieldId } = c.req.param();
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM item_field_values WHERE field_id = ?").bind(fieldId),
    c.env.DB.prepare("DELETE FROM item_field_locks WHERE field_id = ?").bind(fieldId),
    c.env.DB.prepare("DELETE FROM set_fields WHERE id = ? AND set_id = ?").bind(fieldId, setId),
  ]);
  // 削除だけなら残りのフィールドの抽出結果はそのまま使える
  await refreshFieldsHash(c.env, setId, { onlyRemoved: true });
  return c.json({ ok: true });
});

/** 未抽出の item をすぐに抽出（以降は Cron で少しずつ進む） */
userApi.post("/sets/:id/fields/extract", async (c) => {
  if (!c.env.GEMINI_API_KEY) return c.json({ error: "ai_not_configured" }, 400);
  const setId = c.req.param("id");
  c.executionCtx.waitUntil(processFieldExtractions(c.env, { setId, limit: 40 }));
  return c.json({ ok: true }, 202);
});

/** フィールドの値の一覧（text/list は値ごとの件数、date/number は範囲）。検索 UI の候補に使う */
userApi.get("/sets/:id/fields/:key/values", async (c) => {
  const { id: setId, key } = c.req.param();
  const f = await c.env.DB.prepare("SELECT id, type FROM set_fields WHERE set_id = ? AND key = ?").bind(setId, key).first<{ id: string; type: FieldType }>();
  if (!f) return c.json({ error: "not_found" }, 404);
  if (f.type === "text" || f.type === "list") {
    const rs = await c.env.DB.prepare("SELECT value_text AS value, COUNT(DISTINCT item_id) AS count FROM item_field_values WHERE field_id = ? AND value_text IS NOT NULL GROUP BY value_text ORDER BY count DESC, value_text LIMIT 200")
      .bind(f.id)
      .all();
    return c.json({ type: f.type, values: rs.results });
  }
  const col = f.type === "date" ? "value_date" : "value_num";
  const r = await c.env.DB.prepare(`SELECT MIN(${col}) AS min, MAX(${col}) AS max, COUNT(DISTINCT item_id) AS count FROM item_field_values WHERE field_id = ?`).bind(f.id).first();
  return c.json({ type: f.type, ...r });
});

// ---- item のカスタムフィールド（表示・手動修正） ----

/** item が属するセットのフィールドすべて（値なしも含む）と、手動修正の有無・抽出状況・修正履歴 */
async function itemCustomFields(env: Env, itemId: string, subscriptionId: string) {
  const fields = await env.DB.prepare(
    `SELECT f.id, f.set_id, f.key, f.label, f.type, f.description, f.position, st.name AS set_name, st.fields_hash
     FROM set_members m JOIN sets st ON st.id = m.set_id JOIN set_fields f ON f.set_id = st.id WHERE m.subscription_id = ? ORDER BY st.position, st.created_at, f.position, f.created_at`,
  )
    .bind(subscriptionId)
    .all<SetField & { set_name: string; fields_hash: string | null }>();
  if (!fields.results.length) return [];
  const vals = await env.DB.prepare("SELECT field_id, value_text, value_num, value_date FROM item_field_values WHERE item_id = ? ORDER BY ord").bind(itemId).all<{ field_id: string; value_text: string | null; value_num: number | null; value_date: string | null }>();
  const locks = await env.DB.prepare("SELECT field_id, locked_by, locked_at FROM item_field_locks WHERE item_id = ?").bind(itemId).all<{ field_id: string; locked_by: string; locked_at: string }>();
  const ex = await env.DB.prepare("SELECT set_id, schema_hash, status, error, updated_at FROM item_field_extractions WHERE item_id = ?").bind(itemId).all<{ set_id: string; schema_hash: string; status: string; error: string | null; updated_at: string }>();
  const edits = await env.DB.prepare("SELECT field_id, action, before_json, after_json, user_id, created_at FROM item_field_edits WHERE item_id = ? ORDER BY created_at DESC LIMIT 50").bind(itemId).all<{ field_id: string; action: string; before_json: string; after_json: string | null; user_id: string; created_at: string }>();
  return fields.results.map((f) => {
    const lock = locks.results.find((l) => l.field_id === f.id);
    const e = ex.results.find((x) => x.set_id === f.set_id);
    return {
      set_id: f.set_id,
      set_name: f.set_name,
      field_id: f.id,
      key: f.key,
      label: f.label,
      type: f.type,
      values: vals.results.filter((v) => v.field_id === f.id).map((v) => displayValue(f.type, v)),
      manual: lock ? { by: lock.locked_by, at: lock.locked_at } : null,
      extraction: e ? { status: e.schema_hash === f.fields_hash ? e.status : "stale", error: e.error, at: e.updated_at } : { status: "pending" },
      history: edits.results.filter((h) => h.field_id === f.id).map((h) => ({ action: h.action, before: json(h.before_json, []), after: json(h.after_json, null), by: h.user_id, at: h.created_at })),
    };
  });
}

async function fieldForItem(env: Env, itemId: string, setId: string, key: string): Promise<SetField | { error: string; status: 400 | 404 }> {
  const it = await env.DB.prepare("SELECT subscription_id FROM items WHERE id = ?").bind(itemId).first<{ subscription_id: string }>();
  if (!it) return { error: "item_not_found", status: 404 };
  if (!(await env.DB.prepare("SELECT 1 FROM set_members WHERE set_id = ? AND subscription_id = ?").bind(setId, it.subscription_id).first())) return { error: "item_not_in_set", status: 400 };
  const f = await env.DB.prepare("SELECT id, set_id, key, label, type, description, position FROM set_fields WHERE set_id = ? AND key = ?").bind(setId, key).first<SetField>();
  if (!f) return { error: "field_not_found", status: 404 };
  return f;
}

/** 手で値を設定（{"values": [...]}。空配列は「値なし」）。以降 AI はこのフィールドを変更しない */
userApi.put("/items/:id/fields/:setId/:key", async (c) => {
  const { id, setId, key } = c.req.param();
  const f = await fieldForItem(c.env, id, setId, key);
  if ("error" in f) return c.json({ error: f.error }, f.status);
  const b = await c.req.json<{ values?: unknown[] }>();
  if (!Array.isArray(b.values)) return c.json({ error: "values_required" }, 400);
  const r = await setManualValues(c.env, id, f, f.type === "list" ? b.values : b.values[0] ?? null, c.get("userId"));
  if ("error" in r) return c.json(r, 400);
  return c.json({ ok: true, ...r });
});

/** 手動の値をやめて AI の値に戻す */
userApi.delete("/items/:id/fields/:setId/:key", async (c) => {
  const { id, setId, key } = c.req.param();
  const f = await fieldForItem(c.env, id, setId, key);
  if ("error" in f) return c.json({ error: f.error }, f.status);
  if (!(await revertManualValues(c.env, id, f, c.get("userId")))) return c.json({ error: "not_manual" }, 400);
  if (c.env.GEMINI_API_KEY) c.executionCtx.waitUntil(processFieldExtractions(c.env, { setId, itemId: id, limit: 1 }));
  return c.json({ ok: true });
});

// ---- セットの公開ページ ----
userApi.put("/sets/:id/publish", async (c) => {
  const id = c.req.param("id");
  const st = await c.env.DB.prepare("SELECT id FROM sets WHERE id = ?").bind(id).first();
  if (!st) return c.json({ error: "not_found" }, 404);
  const b = await c.req.json<{ is_public?: boolean; slug?: string; title?: string; description?: string; options?: PublicOptions }>();
  const slug = (b.slug ?? "").trim().toLowerCase();
  if (b.is_public && !slug) return c.json({ error: "slug_required" }, 400);
  if (slug && !SLUG_RE.test(slug)) return c.json({ error: "bad_slug" }, 400);
  if (slug && (await c.env.DB.prepare("SELECT 1 FROM sets WHERE public_slug = ? AND id != ?").bind(slug, id).first())) return c.json({ error: "slug_taken" }, 409);
  const fields = await loadFields(c.env, id);
  const keys = new Map(fields.map((f) => [f.key, f]));
  const o = b.options ?? {};
  const opts: PublicOptions = {
    fields: (o.fields ?? []).filter((k) => keys.has(k)),
    period: o.period && keys.get(o.period.start)?.type === "date" && keys.get(o.period.end)?.type === "date" ? { start: o.period.start, end: o.period.end } : null,
    facet: o.facet && ["list", "text"].includes(keys.get(o.facet)?.type ?? "") ? o.facet : null,
  };
  await c.env.DB.prepare("UPDATE sets SET is_public = ?, public_slug = ?, public_title = ?, public_description = ?, public_options_json = ?, updated_at = ? WHERE id = ?")
    .bind(b.is_public ? 1 : 0, slug || null, (b.title ?? "").trim().slice(0, 80) || null, (b.description ?? "").trim().slice(0, 400) || null, JSON.stringify(opts), nowIso(), id)
    .run();
  return c.json({ ok: true, path: slug ? `/p/${slug}` : null });
});
