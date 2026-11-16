// クロール結果の取り込みと新着・更新判定（docs/design.md §5, §6.3, §11）
import { decideRunOutcome, sortKey, primaryLink, itemImageFromData, type PageSubmission, type CompleteSubmission, type ItemData } from "@ws/shared";
import { type Env, newId, nowIso, json } from "./env.js";
import { scheduleRetry, retryCountOf, type SubRow } from "./jobs.js";

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

interface RunRow {
  id: string;
  subscription_id: string;
  job_id: string;
  trigger: string;
  config_version_id: string;
  run_status: string;
  finished_at: string | null;
  new_items: number;
  updated_items: number;
  seen_items: number;
  channel_changed: number;
  baseline_run: number;
  rebaseline: number;
}

async function checkIdempotent(env: Env, jobId: string, key: string): Promise<unknown | null> {
  const r = await env.DB.prepare("SELECT response_json FROM submissions WHERE job_id = ? AND submission_key = ?").bind(jobId, key).first<{ response_json: string }>();
  return r ? JSON.parse(r.response_json) : null;
}

async function loadRunForSubmit(env: Env, runId: string, leaseToken: string) {
  const run = await env.DB.prepare("SELECT * FROM crawl_runs WHERE id = ?").bind(runId).first<RunRow>();
  if (!run) throw new HttpError(404, "run_not_found");
  const job = await env.DB.prepare("SELECT id, status, lease_token FROM jobs WHERE id = ?").bind(run.job_id).first<{ id: string; status: string; lease_token: string }>();
  if (!job) throw new HttpError(404, "job_not_found");
  return { run, job, leaseOk: job.lease_token === leaseToken && job.status === "leased" };
}

const textOf = (d: ItemData) => d.title?.value?.replace(/<[^>]+>/g, "").slice(0, 500) ?? null;

export async function ingestPage(env: Env, runId: string, body: PageSubmission): Promise<unknown> {
  const { run, job, leaseOk } = await loadRunForSubmit(env, runId, body.lease_token);
  const prev = await checkIdempotent(env, job.id, body.submission_key);
  if (prev) return prev;
  if (run.finished_at) throw new HttpError(409, "run_finalized");
  if (!leaseOk) throw new HttpError(409, "lease_lost");

  const cv = await env.DB.prepare("SELECT identity_scheme_hash, hash_scheme_hash FROM config_versions WHERE id = ?").bind(run.config_version_id).first<{ identity_scheme_hash: string; hash_scheme_hash: string }>();
  if (!cv) throw new HttpError(500, "config_missing");
  const now = nowIso();
  const subId = run.subscription_id;
  const stmts: D1PreparedStatement[] = [];
  const p = body.page;

  // ---- channel ----
  let channelChanged = false;
  if (body.channel) {
    const cur = await env.DB.prepare("SELECT content_hash, json_extract(data_json, '$.logo') AS logo FROM channels WHERE subscription_id = ?").bind(subId).first<{ content_hash: string; logo: string | null }>();
    // 画像は変更検知の対象外：今回取れなかったときは保存済みのものを残す
    if (cur?.logo && !body.channel.data.logo) body.channel.data.logo = JSON.parse(cur.logo);
    if (!cur) {
      stmts.push(
        env.DB.prepare("INSERT INTO channels (subscription_id, data_json, content_hash, first_seen_run_id, last_changed_run_id, updated_at) VALUES (?, ?, ?, ?, ?, ?)").bind(
          subId,
          JSON.stringify(body.channel.data),
          body.channel.content_hash,
          runId,
          runId,
          now,
        ),
        env.DB.prepare("INSERT INTO channel_revisions (id, subscription_id, run_id, data_json, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(newId(), subId, runId, JSON.stringify(body.channel.data), body.channel.content_hash, now),
      );
    } else if (cur.content_hash === body.channel.content_hash) {
      const logo = body.channel.data.logo ? JSON.stringify(body.channel.data.logo) : null;
      if (logo && logo !== cur.logo) stmts.push(env.DB.prepare("UPDATE channels SET data_json = json_set(data_json, '$.logo', json(?)) WHERE subscription_id = ?").bind(logo, subId));
    } else if (cur.content_hash !== body.channel.content_hash) {
      channelChanged = !run.baseline_run;
      stmts.push(
        env.DB.prepare("UPDATE channels SET data_json = ?, content_hash = ?, last_changed_run_id = ?, updated_at = ? WHERE subscription_id = ?").bind(JSON.stringify(body.channel.data), body.channel.content_hash, runId, now, subId),
        env.DB.prepare("INSERT INTO channel_revisions (id, subscription_id, run_id, data_json, content_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)").bind(newId(), subId, runId, JSON.stringify(body.channel.data), body.channel.content_hash, now),
      );
    }
  }

  // ---- items ----
  const valid = body.items.filter((i) => i.valid && i.identity_key);
  const invalid = body.items.length - valid.length;
  const keys = [...new Set(valid.map((i) => i.identity_key!))];
  const existing = new Map<string, { id: string; content_hash: string; hash_scheme: string }>();
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    const rs = await env.DB.prepare(`SELECT id, identity_key, content_hash, hash_scheme FROM items WHERE subscription_id = ? AND identity_scheme = ? AND identity_key IN (${chunk.map(() => "?").join(",")})`)
      .bind(subId, cv.identity_scheme_hash, ...chunk)
      .all<{ id: string; identity_key: string; content_hash: string; hash_scheme: string }>();
    for (const r of rs.results) existing.set(r.identity_key, r);
  }
  const observed = new Set<string>();
  if (existing.size) {
    const ids = [...existing.values()].map((e) => e.id);
    for (let i = 0; i < ids.length; i += 50) {
      const chunk = ids.slice(i, i + 50);
      const rs = await env.DB.prepare(`SELECT item_id FROM item_observations WHERE run_id = ? AND item_id IN (${chunk.map(() => "?").join(",")})`).bind(runId, ...chunk).all<{ item_id: string }>();
      for (const r of rs.results) observed.add(r.item_id);
    }
  }

  let nNew = 0,
    nUpd = 0,
    nSeen = 0;
  const processed = new Set<string>();
  for (const it of valid) {
    const key = it.identity_key!;
    if (processed.has(key)) continue;
    processed.add(key);
    const data = it.data;
    const dataJson = JSON.stringify(data);
    const link = primaryLink(data) ?? null;
    const pub = sortKey(data.published_at) ?? sortKey(data.updated_at);
    // 画像：配信元データの指定を優先し、なければリンク先の og:image
    const feedImage = itemImageFromData(data) ?? null;
    const ogImage = it.image_lookup?.url ?? null;
    const image = feedImage ? { url: feedImage, source: "feed" } : ogImage ? { url: ogImage, source: "og_image" } : null;
    const checkedAt = it.image_lookup ? now : null;
    let ex = existing.get(key);

    // 識別方式変更後の再基準化：副キー（source_id → 閲覧URL）で旧itemへ付け替え
    if (!ex && run.rebaseline) {
      const alt =
        (data.source_id &&
          (await env.DB.prepare("SELECT id, content_hash, hash_scheme FROM items WHERE subscription_id = ? AND identity_scheme != ? AND source_id = ? LIMIT 1").bind(subId, cv.identity_scheme_hash, data.source_id).first<{ id: string; content_hash: string; hash_scheme: string }>())) ||
        (link &&
          (await env.DB.prepare("SELECT id, content_hash, hash_scheme FROM items WHERE subscription_id = ? AND identity_scheme != ? AND primary_link = ? LIMIT 1").bind(subId, cv.identity_scheme_hash, link).first<{ id: string; content_hash: string; hash_scheme: string }>()));
      if (alt) {
        stmts.push(env.DB.prepare("UPDATE items SET identity_scheme = ?, identity_key = ? WHERE id = ?").bind(cv.identity_scheme_hash, key, alt.id));
        ex = { ...alt, hash_scheme: "rekeyed" }; // ハッシュ定義が変わりうるので黙って再計算
      }
    }

    if (!ex) {
      const id = newId();
      stmts.push(
        env.DB.prepare(
          `INSERT INTO items (id, subscription_id, identity_scheme, identity_key, source_id, data_json, content_hash, hash_scheme, title_text, primary_link, published_sort, is_baseline,
            first_seen_run_id, first_seen_at, last_seen_run_id, last_seen_at, revision_count, image_url, image_source, image_checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        ).bind(id, subId, cv.identity_scheme_hash, key, data.source_id ?? null, dataJson, it.content_hash, cv.hash_scheme_hash, textOf(data), link, pub, run.baseline_run ? 1 : 0, runId, now, runId, now, image?.url ?? null, image?.source ?? null, checkedAt),
        env.DB.prepare("INSERT INTO item_revisions (id, item_id, run_id, content_hash, data_json, change_kind, created_at) VALUES (?, ?, ?, ?, ?, 'created', ?)").bind(newId(), id, runId, it.content_hash, dataJson, now),
        env.DB.prepare("INSERT OR IGNORE INTO item_observations (run_id, item_id, page_seq, position) VALUES (?, ?, ?, ?)").bind(runId, id, p.seq, it.position),
      );
      if (!run.baseline_run) nNew++;
      nSeen++;
      continue;
    }
    if (observed.has(ex.id)) continue; // 同じ実行で既に計上済み（再送など）
    nSeen++;
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO item_observations (run_id, item_id, page_seq, position) VALUES (?, ?, ?, ?)").bind(runId, ex.id, p.seq, it.position));
    // 画像は変更検知の対象外。配信元の指定は常に反映し、og:image は確認したときだけ反映する（見つからなくても既存の画像は消さない）
    if (feedImage) stmts.push(env.DB.prepare("UPDATE items SET image_url = ?, image_source = 'feed' WHERE id = ? AND image_url IS NOT ?").bind(feedImage, ex.id, feedImage));
    else if (it.image_lookup)
      stmts.push(
        env.DB.prepare("UPDATE items SET image_url = COALESCE(?, image_url), image_source = CASE WHEN ? IS NOT NULL THEN 'og_image' ELSE image_source END, image_checked_at = ? WHERE id = ?").bind(ogImage, ogImage, now, ex.id),
      );
    if (ex.hash_scheme !== cv.hash_scheme_hash) {
      // ハッシュ定義の変更：更新とはみなさず再計算値で置き換える
      stmts.push(
        env.DB.prepare("UPDATE items SET content_hash = ?, hash_scheme = ?, data_json = ?, title_text = ?, primary_link = ?, published_sort = ?, source_id = ?, last_seen_run_id = ?, last_seen_at = ? WHERE id = ?").bind(
          it.content_hash,
          cv.hash_scheme_hash,
          dataJson,
          textOf(data),
          link,
          pub,
          data.source_id ?? null,
          runId,
          now,
          ex.id,
        ),
      );
    } else if (ex.content_hash !== it.content_hash) {
      stmts.push(
        env.DB.prepare(
          "UPDATE items SET content_hash = ?, data_json = ?, title_text = ?, primary_link = ?, published_sort = ?, source_id = ?, last_seen_run_id = ?, last_seen_at = ?, last_changed_run_id = ?, last_changed_at = ?, revision_count = revision_count + 1 WHERE id = ?",
        ).bind(it.content_hash, dataJson, textOf(data), link, pub, data.source_id ?? null, runId, now, runId, now, ex.id),
        env.DB.prepare("INSERT INTO item_revisions (id, item_id, run_id, content_hash, data_json, change_kind, created_at) VALUES (?, ?, ?, ?, ?, 'updated', ?)").bind(newId(), ex.id, runId, it.content_hash, dataJson, now),
      );
      if (!run.baseline_run) nUpd++;
    } else {
      stmts.push(env.DB.prepare("UPDATE items SET last_seen_run_id = ?, last_seen_at = ? WHERE id = ?").bind(runId, now, ex.id));
    }
  }

  stmts.push(
    env.DB.prepare(
      `INSERT OR IGNORE INTO crawl_pages (run_id, seq, kind, url, fetched_at, http_status, http_status_source, action_result, extract_status, item_count, new_unique_items, field_failures_json, list_signature, error, subresource_failures, snapshot_key, timings_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      runId,
      p.seq,
      p.kind,
      p.url,
      p.fetched_at,
      p.http_status,
      p.http_status_source,
      p.action_result,
      p.extract_status,
      p.item_count,
      body.items.length,
      p.field_failures ? JSON.stringify(p.field_failures) : null,
      p.list_signature ?? null,
      p.error ?? null,
      p.subresource_failures ?? null,
      p.snapshot_key ?? null,
      p.timings ? JSON.stringify(p.timings) : null,
    ),
    env.DB.prepare(
      "UPDATE crawl_runs SET new_items = new_items + ?, updated_items = updated_items + ?, seen_items = seen_items + ?, invalid_items = invalid_items + ?, channel_changed = MAX(channel_changed, ?) WHERE id = ?",
    ).bind(nNew, nUpd, nSeen, invalid, channelChanged ? 1 : 0, runId),
  );
  const resp = { ok: true, new: nNew, updated: nUpd, seen: nSeen, invalid };
  stmts.push(env.DB.prepare("INSERT INTO submissions (job_id, submission_key, response_json, created_at) VALUES (?, ?, ?, ?)").bind(job.id, body.submission_key, JSON.stringify(resp), now));
  await env.DB.batch(stmts);
  return resp;
}

export interface CompleteHooks {
  onExtractFailure(sub: SubRow, runId: string): Promise<void>;
}

export async function completeRun(env: Env, runId: string, body: CompleteSubmission, hooks: CompleteHooks): Promise<unknown> {
  const { run, job, leaseOk } = await loadRunForSubmit(env, runId, body.lease_token);
  const prev = await checkIdempotent(env, job.id, body.submission_key);
  if (prev) return prev;
  if (run.finished_at) throw new HttpError(409, "run_finalized");
  if (!leaseOk) throw new HttpError(409, "lease_lost");
  const resp = await finalizeRun(env, run, body, hooks);
  await env.DB.batch([
    env.DB.prepare("UPDATE jobs SET status = 'done', finished_at = ? WHERE id = ?").bind(nowIso(), job.id),
    env.DB.prepare("INSERT INTO submissions (job_id, submission_key, response_json, created_at) VALUES (?, ?, ?, ?)").bind(job.id, body.submission_key, JSON.stringify(resp), nowIso()),
  ]);
  return resp;
}

/** リース切れで VPS から完了報告が来なかった実行を締める */
export async function finalizeExpiredRun(env: Env, runId: string, hooks: CompleteHooks) {
  const run = await env.DB.prepare("SELECT * FROM crawl_runs WHERE id = ?").bind(runId).first<RunRow>();
  if (!run || run.finished_at) return;
  const pages = await env.DB.prepare("SELECT COUNT(*) AS n FROM crawl_pages WHERE run_id = ?").bind(runId).first<{ n: number }>();
  await finalizeRun(
    env,
    run,
    {
      lease_token: "",
      submission_key: "",
      traversal: "incomplete",
      end_reason: "lease_expired",
      extract_status: "skipped",
      error_stage: "internal",
      error_detail: "crawler did not report completion before lease expiry",
      pages_fetched: pages?.n ?? 0,
      actions_performed: 0,
      started_at: nowIso(),
      finished_at: nowIso(),
      worker_id: "",
      crawler_version: "",
      engine_version: "",
      retryable: true,
    },
    hooks,
  );
}

async function finalizeRun(env: Env, run: RunRow, body: CompleteSubmission, hooks: CompleteHooks) {
  const now = nowIso();
  const sub = await env.DB.prepare("SELECT * FROM subscriptions WHERE id = ?").bind(run.subscription_id).first<SubRow>();
  if (!sub) throw new HttpError(404, "subscription_not_found");
  const r = await env.DB.prepare("SELECT new_items, updated_items, seen_items, channel_changed, rebaseline, baseline_run FROM crawl_runs WHERE id = ?").bind(run.id).first<RunRow>();
  const okPages = await env.DB.prepare("SELECT COUNT(*) AS n FROM crawl_pages WHERE run_id = ? AND extract_status = 'success'").bind(run.id).first<{ n: number }>();
  const anyData = (r!.seen_items ?? 0) > 0 || (okPages?.n ?? 0) > 0;
  const cv = await env.DB.prepare("SELECT identity_scheme_hash FROM config_versions WHERE id = ?").bind(run.config_version_id).first<{ identity_scheme_hash: string }>();

  const outcome = decideRunOutcome({
    baselineStatusBefore: sub.baseline_status,
    traversal: body.traversal,
    extractStatus: body.extract_status,
    fatal: false,
    newItems: r!.new_items,
    updatedItems: r!.updated_items,
    channelChanged: !!r!.channel_changed,
    anyDataObtained: anyData,
    rebaseline: !!r!.rebaseline,
  });

  // 健全性
  let health = "ok";
  let healthDetail: string | null = null;
  const extractProblem = body.extract_status === "failed" || body.end_reason === "wait_timeout" || body.end_reason === "config_error";
  if (body.error_stage === "fetch" || body.error_stage === "robots") {
    health = "fetch_error";
    healthDetail = body.error_detail ?? null;
  } else if (extractProblem) {
    health = "extract_error";
    healthDetail = body.error_detail ?? null;
  } else if (body.end_reason === "lease_expired") {
    health = "unknown";
    healthDetail = "crawler did not finish";
  } else if (outcome.runStatus === "completed") {
    const prevOk = await env.DB.prepare(
      "SELECT seen_items FROM crawl_runs WHERE subscription_id = ? AND run_status = 'completed' AND id != ? ORDER BY finished_at DESC LIMIT 1",
    )
      .bind(sub.id, run.id)
      .first<{ seen_items: number }>();
    if (prevOk && prevOk.seen_items >= 5 && r!.seen_items === 0) {
      health = "degraded";
      healthDetail = `item数が ${prevOk.seen_items} → 0 に急減`;
    }
    if (["max_pages", "max_actions", "max_duration"].includes(body.end_reason)) healthDetail = `上限到達で終了 (${body.end_reason})`;
  }
  const success = outcome.runStatus === "completed";
  // リンク先 og:image の試行結果を購読に記憶する（以降は自動で取得／取得しない）
  const ii = body.item_images;
  const learnedImageMode = !sub.item_image_mode && ii?.mode === "trial" && ii.tried > 0 ? (ii.found > 0 ? "og_image" : "off") : null;
  const changed = outcome.changeStatus === "changed";
  const consecutiveFailures = success ? 0 : sub.consecutive_failures + 1;
  const consecutiveExtract = extractProblem ? sub.consecutive_extract_failures + 1 : success ? 0 : sub.consecutive_extract_failures;

  await env.DB.batch([
    env.DB.prepare(
      `UPDATE crawl_runs SET run_status = ?, extract_status = ?, change_status = ?, pages_fetched = ?, actions_performed = ?, end_reason = ?, error_stage = ?, error_detail = ?,
        baseline_incomplete = ?, started_at = COALESCE(started_at, ?), finished_at = ?, worker_id = COALESCE(NULLIF(?, ''), worker_id), crawler_version = ?, engine_version = ? WHERE id = ?`,
    ).bind(
      outcome.runStatus,
      body.extract_status,
      outcome.changeStatus,
      body.pages_fetched,
      body.actions_performed,
      body.end_reason,
      body.error_stage ?? null,
      body.error_detail ?? null,
      outcome.baselineIncomplete ? 1 : 0,
      body.started_at,
      now,
      body.worker_id,
      body.crawler_version || null,
      body.engine_version || null,
      run.id,
    ),
    env.DB.prepare(
      `UPDATE subscriptions SET last_attempt_at = ?, last_success_at = CASE WHEN ? THEN ? ELSE last_success_at END, last_change_at = CASE WHEN ? THEN ? ELSE last_change_at END,
        baseline_status = ?, baseline_identity_scheme = CASE WHEN ? THEN ? ELSE baseline_identity_scheme END, health = ?, health_detail = ?, consecutive_failures = ?, consecutive_extract_failures = ?, updated_at = ? WHERE id = ?`,
    ).bind(
      now,
      success ? 1 : 0,
      now,
      changed ? 1 : 0,
      now,
      outcome.baselineStatusAfter,
      outcome.baselineStatusAfter !== "none" ? 1 : 0,
      cv?.identity_scheme_hash ?? null,
      health,
      healthDetail,
      consecutiveFailures,
      consecutiveExtract,
      now,
      sub.id,
    ),
    ...(learnedImageMode ? [env.DB.prepare("UPDATE subscriptions SET item_image_mode = ? WHERE id = ? AND item_image_mode IS NULL").bind(learnedImageMode, sub.id)] : []),
  ]);

  // 成功時の最新スナップショットは期限なしで保持（修正提案の比較元）
  if (success) {
    const snaps = await env.DB.prepare("SELECT seq, snapshot_key FROM crawl_pages WHERE run_id = ? AND snapshot_key IS NOT NULL ORDER BY seq LIMIT 3").bind(run.id).all<{ seq: number; snapshot_key: string }>();
    for (const sn of snaps.results) {
      const o = await env.BLOBS.get(sn.snapshot_key);
      if (o) await env.BLOBS.put(`latest/${sub.id}/${sn.snapshot_key.split("/").pop()}`, o.body, { httpMetadata: o.httpMetadata, customMetadata: { run_id: run.id } });
    }
  }

  // 同日内リトライ（一時的失敗のみ）
  if (!success && body.retryable && !extractProblem) {
    const n = await retryCountOf(env, run.id);
    await scheduleRetry(env, sub.id, run.id, n + 1);
  }
  // 抽出の連続失敗で修正提案を自動作成
  if (extractProblem && consecutiveExtract >= Number(env.REPAIR_AFTER_FAILURES || 2)) {
    await hooks.onExtractFailure({ ...sub, consecutive_extract_failures: consecutiveExtract }, run.id);
  }
  return { ok: true, run_status: outcome.runStatus, change_status: outcome.changeStatus, health };
}

export function parseJson<T>(s: string | null, d: T): T {
  return json(s, d);
}
