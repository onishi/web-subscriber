// 1回のクロール（取得・待機・抽出・ページング）。docs/design.md §4.6
import { gzipSync } from "node:zlib";
import type { Page } from "playwright";
import {
  type SubscriptionConfig,
  type PageSubmission,
  type SubmittedItem,
  type EndReason,
  type ErrorStage,
  type ExtractStatus,
  type ItemData,
  type Wait,
  identityKey,
  itemContentHash,
  channelContentHash,
  appValidateItem,
} from "@ws/shared";
import type { ListSnapshot, PageExtraction } from "@ws/shared/dom";
import { openPage, ws, type OpenedPage } from "./browser.js";
import { checkRobots, httpGet, FetchError, BlockedHostError } from "./net.js";
import { parseFeed, looksLikeFeed } from "./feed.js";
import { settings } from "./settings.js";
import { fetchOgImage, type ImageEnricher } from "./images.js";
import type { DetailEnricher } from "./detail.js";

export type PageInfo = PageSubmission["page"];

export interface CrawlSink {
  page(p: { page: PageInfo; channel: PageSubmission["channel"]; items: SubmittedItem[] }): Promise<void>;
  artifact(name: string, data: Buffer, contentType: string): Promise<string | null>;
}

export interface CrawlOutcome {
  traversal: "complete" | "incomplete";
  end_reason: EndReason;
  extract_status: ExtractStatus;
  error_stage: ErrorStage | null;
  error_detail: string | null;
  pages_fetched: number;
  actions_performed: number;
  retryable: boolean;
  format_validation?: unknown;
}

const now = () => new Date().toISOString();

async function toSubmitted(cfg: SubscriptionConfig, data: ItemData, position: number, valid: boolean, failures?: SubmittedItem["failures"]): Promise<SubmittedItem> {
  const id = await identityKey(data, cfg.identity);
  const appIssues = appValidateItem(data);
  return {
    identity_key: id.ok ? id.key : null,
    identity_error: id.ok ? undefined : id.reason,
    content_hash: await itemContentHash(data, cfg.change_detection.fields),
    valid: valid && id.ok && appIssues.length === 0,
    failures: [...(failures ?? []), ...appIssues.map((i) => ({ field: "_app", status: "error", reason: i.code }))],
    position,
    data,
  };
}

export interface CrawlOptions {
  saveSnapshots?: boolean;
  /** リンク先 og:image の取得 */
  images?: ImageEnricher;
  /** 詳細ページの取得（config.detail） */
  detail?: DetailEnricher;
}

export async function crawl(cfg: SubscriptionConfig, sink: CrawlSink, opts: CrawlOptions = {}): Promise<CrawlOutcome> {
  const url = cfg.source.url;
  const base: Omit<CrawlOutcome, "end_reason" | "traversal"> = {
    extract_status: "skipped",
    error_stage: null,
    error_detail: null,
    pages_fetched: 0,
    actions_performed: 0,
    retryable: false,
  };

  if (cfg.politeness.respect_robots_txt) {
    const r = await checkRobots(url);
    if (!r.allowed) {
      await sink.page({
        page: { seq: 0, kind: "initial", url, fetched_at: now(), http_status: null, http_status_source: "none", action_result: null, extract_status: "skipped", item_count: 0, error: r.detail },
        channel: null,
        items: [],
      });
      return { ...base, traversal: "incomplete", end_reason: "robots_disallowed", error_stage: "robots", error_detail: r.detail };
    }
  }

  if (cfg.source.kind === "feed") return crawlFeed(cfg, sink, base, opts);
  return crawlHtml(cfg, sink, base, opts);
}

async function crawlFeed(cfg: SubscriptionConfig, sink: CrawlSink, base: Omit<CrawlOutcome, "end_reason" | "traversal">, opts: CrawlOptions): Promise<CrawlOutcome> {
  const url = cfg.source.url;
  const fetchedAt = now();
  let res;
  try {
    res = await httpGet(url, { headers: cfg.fetch.headers, timeoutMs: cfg.fetch.timeout_ms, minIntervalMs: cfg.politeness.min_interval_ms, cacheTtlMs: settings.httpCacheSourceTtlMs });
  } catch (e) {
    const msg = (e as Error).message;
    await sink.page({ page: { seq: 0, kind: "initial", url, fetched_at: fetchedAt, http_status: null, http_status_source: "none", action_result: null, extract_status: "skipped", item_count: 0, error: msg }, channel: null, items: [] });
    return { ...base, traversal: "incomplete", end_reason: "error", error_stage: "fetch", error_detail: msg, retryable: e instanceof FetchError ? e.retryable : !(e instanceof BlockedHostError) };
  }
  const snapshot = await sink.artifact("page-0.xml.gz", gzipSync(res.body), "application/gzip").catch(() => null);
  const pageBase: PageInfo = { seq: 0, kind: "initial", url: res.url, fetched_at: fetchedAt, http_status: res.status, http_status_source: "main_document", action_result: null, extract_status: "skipped", item_count: 0, snapshot_key: snapshot, ...(res.cacheAgeMs !== undefined ? { timings: { cache_age_ms: res.cacheAgeMs } } : {}) };
  if (res.status < 200 || res.status >= 300) {
    await sink.page({ page: { ...pageBase, error: `http_status_${res.status}` }, channel: null, items: [] });
    return { ...base, pages_fetched: 1, traversal: "incomplete", end_reason: "error", error_stage: "fetch", error_detail: `HTTP ${res.status}`, retryable: res.status >= 500 || res.status === 429 || res.status === 408 };
  }
  let parsed;
  try {
    parsed = parseFeed(res.body, res.url);
  } catch (e) {
    const msg = (e as Error).message + (looksLikeFeed(res.headers["content-type"] ?? null, res.body) ? "" : " (not a feed)");
    await sink.page({ page: { ...pageBase, extract_status: "failed", error: msg }, channel: null, items: [] });
    return { ...base, pages_fetched: 1, traversal: "incomplete", end_reason: "error", extract_status: "failed", error_stage: "extract", error_detail: msg };
  }
  // フィードにロゴの指定がなければ、チャンネルのリンク先ページの og:image を使う
  if (!parsed.channel.logo) {
    const home = parsed.channel.links.find((l) => l.rel === "alternate")?.href;
    if (home && /^https?:\/\//.test(home)) {
      const og = await fetchOgImage(home, { minIntervalMs: cfg.politeness.min_interval_ms, respectRobots: cfg.politeness.respect_robots_txt });
      if (og) parsed.channel.logo = { url: og };
    }
  }
  const seen = new Set<string>();
  const items: SubmittedItem[] = [];
  for (let i = 0; i < parsed.items.length; i++) {
    const s = await toSubmitted(cfg, parsed.items[i], i, true);
    if (s.identity_key && seen.has(s.identity_key)) continue;
    if (s.identity_key) seen.add(s.identity_key);
    items.push(s);
  }
  await opts.detail?.enrich(items);
  await opts.images?.enrich(items);
  await sink.page({
    page: { ...pageBase, extract_status: "success", item_count: parsed.items.length },
    channel: { data: parsed.channel, content_hash: await channelContentHash(parsed.channel) },
    items,
  });
  return { ...base, pages_fetched: 1, traversal: "complete", end_reason: "single_page", extract_status: "success", format_validation: parsed.format_validation };
}

export async function waitFor(page: Page, cfg: SubscriptionConfig, w: Wait | undefined, before: ListSnapshot | null): Promise<{ ok: boolean; detail: string; ms: number }> {
  const t0 = Date.now();
  if (!w) return { ok: true, detail: "no_wait", ms: 0 };
  const poll = w.poll_ms ?? 200;
  let last = "";
  while (Date.now() - t0 < w.timeout_ms) {
    try {
      const r = await ws(page, "evalCond", w.cond, cfg, before);
      last = r.detail;
      if (r.ok) return { ok: true, detail: r.detail, ms: Date.now() - t0 };
    } catch (e) {
      // ナビゲーション中は評価できないことがある
      last = `eval_error:${(e as Error).message.split("\n")[0]}`;
    }
    await page.waitForTimeout(poll);
  }
  return { ok: false, detail: last, ms: Date.now() - t0 };
}

async function crawlHtml(cfg: SubscriptionConfig, sink: CrawlSink, base: Omit<CrawlOutcome, "end_reason" | "traversal">, opts: CrawlOptions): Promise<CrawlOutcome> {
  const url = cfg.source.url;
  const started = Date.now();
  const limits = cfg.paging.limits;
  let opened: OpenedPage | null = null;
  let pagesFetched = 0;
  let actions = 0;
  const seen = new Set<string>();
  const signatures = new Set<string>();
  let position = 0;
  let anyExtractFailed = false;
  let extractedPages = 0;
  let cacheAgeMs: number | undefined;

  const fail = (stage: ErrorStage, detail: string, retryable = false, end: EndReason = "error"): CrawlOutcome => ({
    ...base,
    pages_fetched: pagesFetched,
    actions_performed: actions,
    traversal: "incomplete",
    end_reason: end,
    extract_status: anyExtractFailed ? "failed" : extractedPages > 0 ? "success" : "skipped",
    error_stage: stage,
    error_detail: detail,
    retryable,
  });

  try {
    // ---- 初回取得 ----
    const fetchedAt = now();
    if (cfg.fetch.method === "http") {
      let res;
      try {
        res = await httpGet(url, { headers: cfg.fetch.headers, timeoutMs: cfg.fetch.timeout_ms, minIntervalMs: cfg.politeness.min_interval_ms, cacheTtlMs: settings.httpCacheSourceTtlMs });
      } catch (e) {
        const msg = (e as Error).message;
        await sink.page({ page: { seq: 0, kind: "initial", url, fetched_at: fetchedAt, http_status: null, http_status_source: "none", action_result: null, extract_status: "skipped", item_count: 0, error: msg }, channel: null, items: [] });
        return fail("fetch", msg, e instanceof FetchError ? e.retryable : false);
      }
      pagesFetched = 1;
      cacheAgeMs = res.cacheAgeMs;
      if (res.status < 200 || res.status >= 300) {
        await sink.page({ page: { seq: 0, kind: "initial", url: res.url, fetched_at: fetchedAt, http_status: res.status, http_status_source: "main_document", action_result: null, extract_status: "skipped", item_count: 0, error: `http_status_${res.status}` }, channel: null, items: [] });
        return fail("fetch", `HTTP ${res.status}`, res.status >= 500 || res.status === 429 || res.status === 408);
      }
      opened = await openPage(cfg, "static", { url: res.url, status: res.status, body: res.body, headers: res.headers });
      await opened.page.goto(res.url, { waitUntil: "domcontentloaded", timeout: cfg.fetch.timeout_ms });
    } else {
      opened = await openPage(cfg, "browser");
      try {
        await opened.page.goto(url, { waitUntil: "domcontentloaded", timeout: cfg.fetch.timeout_ms });
      } catch (e) {
        const main = opened.lastMainResponse();
        const msg = `navigation_error:${(e as Error).message.split("\n")[0]}`;
        await sink.page({ page: { seq: 0, kind: "initial", url, fetched_at: fetchedAt, http_status: main?.status ?? null, http_status_source: main ? "main_document" : "none", action_result: null, extract_status: "skipped", item_count: 0, error: msg }, channel: null, items: [] });
        return fail("fetch", msg, true);
      }
      pagesFetched = 1;
      const main = opened.lastMainResponse();
      if (!main || main.status < 200 || main.status >= 300) {
        await sink.page({ page: { seq: 0, kind: "initial", url: main?.url ?? url, fetched_at: fetchedAt, http_status: main?.status ?? null, http_status_source: main ? "main_document" : "none", action_result: null, extract_status: "skipped", item_count: 0, error: `http_status_${main?.status ?? "none"}` }, channel: null, items: [] });
        return fail("fetch", `HTTP ${main?.status ?? "(none)"}`, !main || main.status >= 500 || main.status === 429);
      }
    }
    const page = opened.page;
    await ws(page, "installTracker");

    let kind: PageInfo["kind"] = "initial";
    let actionResult: string | null = null;
    let waitResult = cfg.fetch.method === "browser" ? await waitFor(page, cfg, cfg.wait.initial, null) : { ok: true, detail: "static", ms: 0 };
    let pageFetchedAt = fetchedAt;
    let pageStatus: { status: number | null; source: "main_document" | "none"; url: string | null } = {
      status: opened.lastMainResponse()?.status ?? null,
      source: "main_document",
      url: opened.lastMainResponse()?.url ?? url,
    };

    for (let seq = 0; ; seq++) {
      if (!waitResult.ok) {
        const snap = await snapshotPage(page, sink, seq, true);
        await sink.page({ page: { seq, kind, url: page.url(), fetched_at: pageFetchedAt, http_status: pageStatus.status, http_status_source: pageStatus.source, action_result: actionResult, extract_status: "skipped", item_count: 0, error: `wait_timeout: ${waitResult.detail}`, subresource_failures: opened.subresourceFailures(), snapshot_key: snap, timings: { wait_ms: waitResult.ms } }, channel: null, items: [] });
        return fail("wait", `wait_timeout (seq ${seq}): ${waitResult.detail}`, false, "wait_timeout");
      }
      const ex: PageExtraction = await ws(page, "extract", cfg, page.url());
      const snap = opts.saveSnapshots !== false ? await snapshotPage(page, sink, seq, ex.status === "failed") : null;
      const listSig = await ws(page, "listSnapshot", cfg);

      // 識別キー・重複排除
      const submitted: SubmittedItem[] = [];
      const pageKeys: string[] = [];
      for (const it of ex.items) {
        const s = await toSubmitted(cfg, it.data, position, it.valid, it.failures);
        if (s.identity_key) {
          pageKeys.push(s.identity_key);
          if (seen.has(s.identity_key)) continue;
          seen.add(s.identity_key);
        }
        position++;
        submitted.push(s);
      }
      const channel = seq === 0 && ex.channel ? { data: ex.channel, content_hash: await channelContentHash(ex.channel) } : null;
      extractedPages++;
      if (ex.status === "failed") anyExtractFailed = true;
      if (ex.status !== "failed") {
        await opts.detail?.enrich(submitted);
        await opts.images?.enrich(submitted);
      }
      await sink.page({
        page: {
          seq,
          kind,
          url: pageStatus.url ?? page.url(),
          fetched_at: pageFetchedAt,
          http_status: pageStatus.status,
          http_status_source: pageStatus.source,
          action_result: actionResult,
          extract_status: ex.status,
          item_count: ex.items.length,
          field_failures: ex.field_failures,
          list_signature: listSig.signature,
          error: ex.status === "failed" ? ex.reason ?? "extract_failed" : null,
          subresource_failures: opened.subresourceFailures(),
          snapshot_key: snap,
          timings: { wait_ms: waitResult.ms, ...(seq === 0 && cacheAgeMs !== undefined ? { cache_age_ms: cacheAgeMs } : {}) },
        },
        channel,
        items: submitted,
      });
      if (ex.status === "failed") return fail("extract", `extract_failed (seq ${seq}): ${ex.reason}`);

      // 循環検知：replace は同じキー集合、append は新規ゼロ
      const keySig = [...pageKeys].sort().join("\n");
      if (seq > 0) {
        if (cfg.paging.mode === "replace" && pageKeys.length > 0 && signatures.has(keySig)) return done("cycle_detected");
        if (cfg.paging.mode === "append" && submitted.length === 0 && ex.items.length > 0) return done("cycle_detected");
      }
      signatures.add(keySig);

      if (cfg.paging.mode === "none") return done("single_page");
      if (limits.max_items && position >= limits.max_items) return done("max_items");
      if (seq + 1 >= limits.max_pages) return done("max_pages");
      if (actions >= limits.max_actions) return done("max_actions");
      if (Date.now() - started >= limits.max_duration_ms) return done("max_duration");

      const nx = await ws(page, "inspectNext", cfg);
      if (nx.error === "multiple_next_elements") return fail("paging", `next selector matched ${nx.count} elements (pick=only)`, false, "config_error");
      if (nx.error) return fail("paging", nx.error, false, "config_error");
      if (nx.count === 0) return done("no_next");
      if (nx.disabled) return done("next_disabled");

      // クリック
      const before = await ws(page, "listSnapshot", cfg);
      const prevMain = opened.lastMainResponse();
      await new Promise((r) => setTimeout(r, cfg.politeness.min_interval_ms));
      const target = page.locator("[data-ws-next]").first();
      try {
        await target.scrollIntoViewIfNeeded({ timeout: 5000 });
        await target.click({ timeout: 10000 });
      } catch (e) {
        return fail("paging", `click_failed: ${(e as Error).message.split("\n")[0]}`);
      }
      actions++;
      await page.evaluate(() => document.querySelectorAll("[data-ws-next]").forEach((e) => e.removeAttribute("data-ws-next"))).catch(() => {});
      pageFetchedAt = now();
      // URL遷移があれば新しい主文書のステータスを記録
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      const curMain = opened.lastMainResponse();
      const navigated = curMain !== prevMain && curMain !== null;
      if (navigated) {
        await ws(page, "installTracker");
        pagesFetched++;
        pageStatus = { status: curMain.status, source: "main_document", url: curMain.url };
        if (curMain.status < 200 || curMain.status >= 300) {
          await sink.page({ page: { seq: seq + 1, kind: "navigate", url: curMain.url, fetched_at: pageFetchedAt, http_status: curMain.status, http_status_source: "main_document", action_result: "navigated", extract_status: "skipped", item_count: 0, error: `http_status_${curMain.status}` }, channel: null, items: [] });
          return fail("fetch", `HTTP ${curMain.status} on page ${seq + 1}`, curMain.status >= 500);
        }
        kind = "navigate";
      } else {
        pageStatus = { status: null, source: "none", url: page.url() };
        kind = cfg.paging.mode === "append" ? "click_append" : "click_replace";
      }
      actionResult = navigated ? "navigated" : "clicked";
      // URL遷移で新しい文書になった場合は文書準備の待機（wait.initial）を使う。
      // 遷移のない操作は after_paging（既定：一覧の内容変化）で「期待した変化」を待つ。
      waitResult = navigated
        ? await waitFor(page, cfg, cfg.wait.initial, null)
        : await waitFor(page, cfg, cfg.wait.after_paging ?? { cond: { items_changed: {} }, timeout_ms: 15000 }, before);
    }
  } catch (e) {
    return fail("internal", (e as Error).stack?.split("\n").slice(0, 3).join(" | ") ?? String(e), true);
  } finally {
    await opened?.close();
  }

  function done(end: EndReason): CrawlOutcome {
    return { ...base, pages_fetched: pagesFetched, actions_performed: actions, traversal: "complete", end_reason: end, extract_status: "success", error_stage: null, error_detail: null };
  }
}

async function snapshotPage(page: Page, sink: CrawlSink, seq: number, withScreenshot: boolean): Promise<string | null> {
  try {
    const html = await ws(page, "serialize");
    const key = await sink.artifact(`page-${seq}.html.gz`, gzipSync(html), "application/gzip");
    if (withScreenshot) {
      const png = await page.screenshot({ fullPage: false, timeout: 5000 });
      await sink.artifact(`page-${seq}.png`, png, "image/png");
    }
    return key;
  } catch {
    return null;
  }
}
