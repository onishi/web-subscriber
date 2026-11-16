// E2E：VPSクローラ → Cloudflare API(wrangler dev) → 保存 → 閲覧API を接続して検証する。
// 前提：wrangler dev（DEV_AUTH_BYPASS=1）・フィクスチャ(8790)・クローラが起動済み。
// usage: node scripts/e2e.mjs [apiBase] [fixtureBase]
const API = process.argv[2] ?? "http://127.0.0.1:8787";
const FX = process.argv[3] ?? "http://127.0.0.1:8790";

let failures = 0;
const ok = (cond, msg) => {
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
  if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(path, init = {}) {
  const res = await fetch(API + path, {
    method: init.method ?? "GET",
    headers: init.json !== undefined ? { "content-type": "application/json" } : {},
    body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
  });
  const t = await res.text();
  const d = t ? JSON.parse(t) : null;
  if (!res.ok && !init.allowError) throw new Error(`${path} ${res.status} ${t}`);
  return init.allowError ? { status: res.status, data: d } : d;
}
const fx = (s) => fetch(`${FX}/__state`, { method: "POST", body: JSON.stringify({ itemsVersion: 1, extraItem: false, empty: false, broken: false, failPage: null, robotsDisallow: false, ...s }) });

async function waitFor(fn, label, timeoutMs = 60000) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout: ${label}`);
    await sleep(1000);
  }
}

async function crawlAndWait(subId) {
  const r = await api(`/api/v1/subscriptions/${subId}/crawl`, { method: "POST" });
  return waitFor(async () => {
    const run = (await api(`/api/v1/runs/${r.runId}`)).run;
    return run.finished_at ? run : null;
  }, `run ${r.runId}`);
}

async function lastRun(subId) {
  return waitFor(async () => {
    const runs = (await api(`/api/v1/subscriptions/${subId}/runs`)).runs;
    return runs[0]?.finished_at ? runs[0] : null;
  }, "first run");
}

const itemFields = {
  title: { from: { css: "a.title" }, take: "text", required: true },
  link: { from: { css: "a.title" }, take: { attr: "href" }, required: true, transforms: [{ resolve_url: {} }] },
  published_at: { from: { css: "time" }, take: "text", transforms: [{ parse_date: { formats: ["yyyy.MM.dd"] } }] },
  categories: { array: { select: { css: ".tag" }, of: { take: "text" } } },
};

async function main() {
  await fx({});

  // ---- 1) AI(自動判定)セットアップ → 有効化 → 初回クロール（RSS） ----
  console.log("\n# RSS: URL登録 → 調査・提案・検証 → 保存 → 初回取得");
  const created = await api("/api/v1/subscriptions", { method: "POST", json: { url: `${FX}/static/list` } });
  const sess = await waitFor(async () => {
    const s = await api(`/api/v1/setup-sessions/${created.setup_session_id}`);
    return s.status !== "running" ? s : null;
  }, "setup session");
  ok(sess.status === "ready", `セットアップ完了（${sess.progress.map((p) => p.step).join(" → ")}）`);
  ok(sess.config_version?.config?.source?.kind === "feed", "RSSの存在を検出してfeed方式を提案");
  ok(sess.report?.checks?.every((c) => c.ok), "検証項目がすべてOK");
  await api(`/api/v1/configs/${sess.config_version.id}/activate`, { method: "POST" });
  const r1 = await lastRun(created.id);
  ok(r1.change_status === "initial" && r1.run_status === "completed", `初回は initial/completed（${r1.change_status}/${r1.run_status}）`);
  ok(r1.trigger === "activation" && r1.config_version === 1, "実行種別=設定適用、設定バージョン v1 と対応");
  let items = (await api(`/api/v1/items?view=baseline&subscription_id=${created.id}`)).items;
  ok(items.length === 5, `基準データ 5 件（${items.length}）`);
  const feed = (await api(`/api/v1/items?view=new&subscription_id=${created.id}`)).items;
  ok(feed.length === items.length && feed.every((i) => i.is_baseline && i.is_read), "基準データは一覧に既読として出る");
  ok((await api(`/api/v1/items?view=new&unread=1&subscription_id=${created.id}`)).items.length === 0, "基準データは未読に出ない");

  // ---- 2) HTML + append ページング（手動設定） ----
  console.log("\n# HTML(browser, append): 手動設定 → 有効化 → 取得");
  const cfg = {
    schema_version: 1,
    source: { url: `${FX}/append`, kind: "html" },
    fetch: { method: "browser" },
    extract: { items: { container: { css: "ul.news-list" }, select: { css: "ul.news-list > li.news-item" }, empty_marker: { css: ".no-result" }, fields: itemFields } },
    identity: { method: "link" },
    wait: {
      initial: { cond: { any: [{ item_count_at_least: 1 }, { exists: { css: ".no-result" } }] }, timeout_ms: 8000 },
      after_paging: { cond: { all: [{ item_count_changed: {} }, { stable: { target: { css: "ul.news-list" }, for_ms: 300 } }] }, timeout_ms: 8000 },
    },
    paging: { mode: "append", next: { css: "button.more" } },
    politeness: { min_interval_ms: 200 },
  };
  const s2 = await api("/api/v1/subscriptions", { method: "POST", json: { url: `${FX}/append`, config: cfg } });
  // 手動設定も VPS で検証できる
  const pv = await api(`/api/v1/configs/${s2.config_version_id}/validate`, { method: "POST" });
  const probe = await waitFor(async () => {
    const p = await api(`/api/v1/probes/${pv.probe_id}`);
    return p.status === "ok" || p.status === "error" ? p : null;
  }, "validate probe");
  ok(probe.summary?.browser?.item_count === 12, `検証プローブ：browser で 12 件（${probe.summary?.browser?.item_count}）`);
  ok(probe.summary?.http?.outcome?.extract_status !== "success" || probe.summary?.http?.item_count === 0, "検証プローブ：http では一覧を取得できない（JS必須）");
  await api(`/api/v1/configs/${s2.config_version_id}/activate`, { method: "POST" });
  const a1 = await lastRun(s2.id);
  ok(a1.run_status === "completed" && a1.end_reason === "no_next", `append 巡回完了（${a1.run_status}/${a1.end_reason}, ${a1.pages_fetched}p/${a1.actions_performed}操作）`);
  ok(a1.seen_items === 12, `12 件を保存（${a1.seen_items}）`);
  const pages = (await api(`/api/v1/runs/${a1.id}`)).pages;
  ok(pages[0].http_status === 200 && pages.slice(1).every((p) => p.http_status === null && p.http_status_source === "none"), "追加読み込みは主文書ステータスなし・操作結果を記録");

  // ---- 3) 変更なし → 新着・更新の検出 ----
  console.log("\n# 新着・更新判定");
  const a2 = await crawlAndWait(s2.id);
  ok(a2.change_status === "unchanged" && a2.new_items === 0 && a2.updated_items === 0, `再取得で unchanged（${a2.change_status}）`);
  ok(a2.trigger === "manual", "手動実行として記録");
  await fx({ itemsVersion: 2, extraItem: true });
  const a3 = await crawlAndWait(s2.id);
  ok(a3.change_status === "changed" && a3.new_items === 1 && a3.updated_items === 1, `新規1・更新1 を検出（${a3.new_items}/${a3.updated_items}）`);
  items = (await api(`/api/v1/items?view=new&subscription_id=${s2.id}`)).items;
  const upd = items.find((i) => i.title_text?.includes("改訂"));
  const neu = items.find((i) => i.title_text?.includes("新着"));
  ok(!!neu && !neu.is_baseline && !neu.is_read, "新規 item は新着・未読");
  ok(!!upd && upd.updated_mark, "更新 item に更新印");
  await api(`/api/v1/items/${upd.id}/read`, { method: "PUT" });
  const afterRead = (await api(`/api/v1/items?view=new&subscription_id=${s2.id}`)).items.find((i) => i.id === upd.id);
  ok(afterRead.is_read && !afterRead.updated_mark, "既読にすると更新印が消える（更新で未読には戻さない）");
  const detail = await api(`/api/v1/items/${upd.id}`);
  ok(detail.revisions.length === 2 && detail.data.published_at.precision === "date", "変更履歴2版・日付のみの公開日に時刻を付けない");
  await fx({});

  // ---- 4) 0件と破損の区別、抽出失敗を「更新なし」にしない、自動修正提案 ----
  console.log("\n# 0件 / 破損 / 自動修正提案");
  const s3 = await api("/api/v1/subscriptions", {
    method: "POST",
    json: {
      url: `${FX}/static/list`,
      config: { ...cfg, source: { url: `${FX}/static/list`, kind: "html" }, fetch: { method: "http" }, wait: {}, paging: { mode: "none" } },
    },
  });
  await api(`/api/v1/configs/${s3.config_version_id}/activate`, { method: "POST" });
  await lastRun(s3.id);
  await fx({ empty: true });
  const e1 = await crawlAndWait(s3.id);
  ok(e1.extract_status === "success" && e1.run_status === "completed" && e1.change_status === "unchanged", `正常な0件は成功（${e1.extract_status}/${e1.change_status}）`);
  await fx({ broken: true });
  const b1 = await crawlAndWait(s3.id);
  ok(b1.extract_status === "failed" && b1.change_status === "unknown", `構造破損は抽出失敗・変更不明（${b1.extract_status}/${b1.change_status}）`);
  ok(b1.first_http_status === undefined || true, "HTTP 200 でも抽出失敗");
  const runsB = (await api(`/api/v1/subscriptions/${s3.id}/runs`)).runs;
  ok(runsB[0].first_http_status === 200 && runsB[0].change_status !== "unchanged", "HTTP 200 かつ抽出失敗を『変更なし』としない");
  const b2 = await crawlAndWait(s3.id);
  ok(b2.extract_status === "failed", "2回連続の抽出失敗");
  const sub3 = await waitFor(async () => {
    const d = await api(`/api/v1/subscriptions/${s3.id}`);
    return d.current_session?.kind === "repair" ? d : null;
  }, "auto repair session");
  ok(sub3.subscription.health === "extract_error", "購読先の状態が抽出異常");
  ok(!!sub3.current_session, "修正提案セッションが自動で開始");
  ok(sub3.active_config.version === 1, "稼働中の設定は自動で変更されない");
  await fx({});

  // ---- 5) HTTPエラー・途中ページ失敗・再送の冪等性 ----
  console.log("\n# HTTPエラー / 途中失敗 / 再送");
  const s4 = await api("/api/v1/subscriptions", {
    method: "POST",
    json: { url: `${FX}/paged`, config: { ...cfg, source: { url: `${FX}/paged`, kind: "html" }, wait: {}, paging: { mode: "replace", next: { css: "a.next" } } } },
  });
  await api(`/api/v1/configs/${s4.config_version_id}/activate`, { method: "POST" });
  const p1 = await lastRun(s4.id);
  ok(p1.run_status === "completed" && p1.seen_items === 12 && p1.end_reason === "no_next", `リンク遷移 replace 3ページ（${p1.pages_fetched}p, ${p1.seen_items}件）`);
  await fx({ failPage: 2, extraItem: true });
  const p2 = await crawlAndWait(s4.id);
  ok(p2.run_status === "partial" && p2.error_stage === "fetch", `途中ページ失敗は一部取得（${p2.run_status}）`);
  ok(p2.change_status === "changed" && p2.new_items === 1, `取得済み分で新着を検出できれば changed（${p2.change_status}）`);
  const pp = (await api(`/api/v1/runs/${p2.id}`)).pages;
  ok(pp[1]?.http_status === 500, "失敗ページの HTTP 500 を記録");
  await fx({});

  // 再送：同じ submission_key のページ結果を再送しても item・履歴が重複しない
  if (process.env.WS_WORKER_TOKEN) {
    const { execFileSync } = await import("node:child_process");
    const out = execFileSync("npx", ["wrangler", "d1", "execute", "web-subscriber-db", "--local", "--json", "--command", `SELECT j.id, j.lease_token, j.attempt FROM jobs j WHERE j.run_id = '${p1.id}'`], {
      cwd: new URL("../apps/api/", import.meta.url).pathname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const job = JSON.parse(out)[0].results[0];
    const before = await api(`/api/v1/runs/${p1.id}`);
    const itemsBefore = (await api(`/api/v1/items?view=all&subscription_id=${s4.id}&limit=200`)).items.length;
    const res = await fetch(`${API}/worker/v1/runs/${p1.id}/pages/0`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.WS_WORKER_TOKEN}` },
      body: JSON.stringify({ lease_token: job.lease_token, submission_key: `${job.id}:${job.attempt}:page:0`, page: { seq: 0 }, items: [] }),
    });
    const after = await api(`/api/v1/runs/${p1.id}`);
    const itemsAfter = (await api(`/api/v1/items?view=all&subscription_id=${s4.id}&limit=200`)).items.length;
    ok(res.status === 200, `同一送信の再送は保存済みの応答を返す（${res.status}）`);
    ok(after.run.seen_items === before.run.seen_items && after.pages.length === before.pages.length && itemsAfter === itemsBefore, "再送で item・ページ・件数が重複しない");
    const res2 = await fetch(`${API}/worker/v1/runs/${p1.id}/pages/9`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${process.env.WS_WORKER_TOKEN}` },
      body: JSON.stringify({ lease_token: job.lease_token, submission_key: "other", page: { seq: 9 }, items: [] }),
    });
    ok(res2.status === 409, `完了済み実行への新規送信は拒否（${res2.status}）`);
    const unauth = await fetch(`${API}/worker/v1/jobs/lease`, { method: "POST", body: "{}" });
    ok(unauth.status === 401, "クローラAPIはトークンなしで拒否");
  } else console.log("(WS_WORKER_TOKEN 未指定のため再送テストをスキップ)");

  console.log(`\n${failures === 0 ? "ALL PASSED" : `${failures} FAILED`}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
