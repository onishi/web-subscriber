// AI初期設定・プレビュー用のプローブ（通常クロールと同じ取得機構を使う）
import type { ProbeRequest, SubscriptionConfig, SubmittedItem } from "@ws/shared";
import { parseConfig } from "@ws/shared";
import type { Outline } from "@ws/shared/dom";
import { openPage, ws } from "./browser.js";
import { checkRobots, httpGet } from "./net.js";
import { parseFeed, looksLikeFeed } from "./feed.js";
import { crawl, type CrawlOutcome, type PageInfo } from "./crawl.js";

type Artifact = (name: string, data: Buffer, contentType: string) => Promise<string | null>;

function minimalConfig(url: string, method: "http" | "browser"): SubscriptionConfig {
  const r = parseConfig({
    schema_version: 1,
    source: { url, kind: "html" },
    fetch: { method },
    extract: { items: { container: { css: "body" }, select: { css: "body" }, fields: {} } },
    identity: { method: "link" },
    politeness: { min_interval_ms: 1000, respect_robots_txt: false },
  });
  if (!r.ok) throw new Error(r.errors.join("; "));
  return r.config;
}

async function feedSummary(url: string) {
  try {
    const r = await httpGet(url, { timeoutMs: 15000, minIntervalMs: 1000 });
    if (r.status !== 200 || !looksLikeFeed(r.headers["content-type"] ?? null, r.body)) return { url, ok: false, status: r.status, reason: "not_feed" };
    const f = parseFeed(r.body, r.url);
    return {
      url: r.url,
      ok: true,
      status: r.status,
      format: f.format,
      title: f.channel.title?.value,
      item_count: f.items.length,
      items_with_content: f.items.filter((i) => i.content).length,
      items_with_summary: f.items.filter((i) => i.summary).length,
      items_with_guid: f.items.filter((i) => i.source_id).length,
      items_with_date: f.items.filter((i) => i.published_at || i.updated_at).length,
      sample: f.items.slice(0, 5).map((i) => ({ title: i.title?.value, link: i.links[0]?.href, published: i.published_at?.raw ?? i.updated_at?.raw, summary_len: i.summary?.value.length ?? 0 })),
      format_validation: f.format_validation.slice(0, 10),
    };
  } catch (e) {
    return { url, ok: false, reason: (e as Error).message };
  }
}

async function discover(url: string, artifact: Artifact) {
  const out: Record<string, unknown> = { url };
  out.robots = await checkRobots(url);
  // HTTP
  let httpRes;
  try {
    httpRes = await httpGet(url, { timeoutMs: 30000, minIntervalMs: 1000 });
    out.http = { status: httpRes.status, final_url: httpRes.url, content_type: httpRes.headers["content-type"], bytes: httpRes.body.length, redirects: httpRes.redirects };
  } catch (e) {
    out.http = { error: (e as Error).message };
  }
  if (httpRes && looksLikeFeed(httpRes.headers["content-type"] ?? null, httpRes.body)) {
    out.is_feed = true;
    out.feeds = [await feedSummary(httpRes.url)];
    return out;
  }
  let staticOutline: Outline | null = null;
  if (httpRes && httpRes.status >= 200 && httpRes.status < 300) {
    const op = await openPage(minimalConfig(httpRes.url, "http"), "static", { url: httpRes.url, status: httpRes.status, body: httpRes.body, headers: httpRes.headers });
    try {
      await op.page.goto(httpRes.url, { waitUntil: "domcontentloaded" });
      staticOutline = await ws(op.page, "buildOutline", 12000);
    } finally {
      await op.close();
    }
  }
  // Browser
  let browserOutline: Outline | null = null;
  const op = await openPage(minimalConfig(url, "browser"), "browser");
  try {
    await op.page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await op.page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    await op.page.waitForTimeout(1000);
    browserOutline = await ws(op.page, "buildOutline", 24000);
    const main = op.lastMainResponse();
    out.browser = { status: main?.status ?? null, final_url: op.page.url(), subresource_failures: op.subresourceFailures() };
    const png = await op.page.screenshot({ fullPage: false }).catch(() => null);
    if (png) out.screenshot_key = await artifact("discover.png", png, "image/png");
  } catch (e) {
    out.browser = { error: (e as Error).message.split("\n")[0] };
  } finally {
    await op.close();
  }
  out.static_outline = staticOutline && { ...staticOutline, outline: staticOutline.outline.slice(0, 6000) };
  out.browser_outline = browserOutline;
  out.comparison = staticOutline && browserOutline
    ? {
        text_length: { http: staticOutline.text_length, browser: browserOutline.text_length },
        link_count: { http: staticOutline.link_count, browser: browserOutline.link_count },
        top_repeat_http: staticOutline.repeats[0]?.item_selector ?? null,
        top_repeat_browser: browserOutline.repeats[0]?.item_selector ?? null,
      }
    : null;
  // フィード候補
  const origin = new URL(url).origin;
  const cands = new Set<string>([...(staticOutline?.feed_links ?? []), ...(browserOutline?.feed_links ?? [])].map((f) => f.href));
  if (cands.size === 0) for (const p of ["/feed", "/rss.xml", "/atom.xml", "/feed.xml", "/index.xml"]) cands.add(origin + p);
  const feeds = [];
  for (const c of [...cands].slice(0, 5)) feeds.push(await feedSummary(c));
  out.feeds = feeds.filter((f) => f.ok || (staticOutline?.feed_links ?? []).some((l) => l.href === f.url));
  return out;
}

function trimItem(s: SubmittedItem) {
  const d = s.data;
  return {
    identity_key: s.identity_key,
    identity_error: s.identity_error,
    valid: s.valid,
    failures: s.failures,
    title: d.title?.value,
    link: d.links.find((l) => l.rel === "alternate")?.href,
    summary: d.summary?.value?.slice(0, 300),
    content_len: d.content?.kind === "inline" ? d.content.value.length : 0,
    published_at: d.published_at,
    updated_at: d.updated_at,
    authors: d.authors,
    categories: d.categories,
    extracted: d.native.format === "html" ? d.native.extracted_fields : undefined,
  };
}

export async function runExtractProbe(config: SubscriptionConfig, maxPages: number | undefined, methods: ("http" | "browser")[], artifact: Artifact) {
  const results: Record<string, unknown> = {};
  for (const m of methods) {
    const cfg: SubscriptionConfig = structuredClone(config);
    cfg.fetch.method = m;
    if (m === "http" && cfg.paging.mode !== "none") cfg.paging.mode = "none"; // http はページング不可
    if (maxPages) cfg.paging.limits.max_pages = Math.min(cfg.paging.limits.max_pages, maxPages);
    const pages: PageInfo[] = [];
    const items: SubmittedItem[] = [];
    let channel: unknown = null;
    let outcome: CrawlOutcome;
    try {
      outcome = await crawl(
        cfg,
        {
          page: async (p) => {
            pages.push(p.page);
            items.push(...p.items);
            if (p.channel) channel = p.channel.data;
          },
          artifact: (name, data, ct) => artifact(`${m}-${name}`, data, ct),
        },
        { saveSnapshots: true },
      );
    } catch (e) {
      results[m] = { error: (e as Error).message };
      continue;
    }
    const keys = items.map((i) => i.identity_key).filter(Boolean);
    results[m] = {
      outcome,
      pages,
      channel,
      item_count: items.length,
      valid_items: items.filter((i) => i.valid).length,
      identity_missing: items.filter((i) => !i.identity_key).length,
      identity_unique: new Set(keys).size === keys.length,
      field_fill: fieldFill(items),
      items: items.slice(0, 40).map(trimItem),
      all_keys: keys,
    };
  }
  return results;
}

function fieldFill(items: SubmittedItem[]) {
  const n = items.length || 1;
  const has = (f: (i: SubmittedItem) => boolean) => Math.round((items.filter(f).length / n) * 100) / 100;
  return {
    title: has((i) => !!i.data.title?.value),
    link: has((i) => i.data.links.some((l) => l.rel === "alternate")),
    summary: has((i) => !!i.data.summary?.value),
    content: has((i) => !!i.data.content),
    published_at: has((i) => !!i.data.published_at?.value),
    published_at_unparsed: has((i) => !!i.data.published_at && !i.data.published_at.value),
    authors: has((i) => i.data.authors.length > 0),
    categories: has((i) => i.data.categories.length > 0),
  };
}

async function inspect(req: Extract<ProbeRequest, { kind: "inspect" }>) {
  const cfg = minimalConfig(req.url, req.method);
  if (req.method === "http") {
    const r = await httpGet(req.url, { timeoutMs: 30000, minIntervalMs: 1000 });
    const op = await openPage(cfg, "static", { url: r.url, status: r.status, body: r.body, headers: r.headers });
    try {
      await op.page.goto(r.url, { waitUntil: "domcontentloaded" });
      return { status: r.status, ...(await ws(op.page, "inspectSelector", req.selector)) };
    } finally {
      await op.close();
    }
  }
  const op = await openPage(cfg, "browser");
  try {
    await op.page.goto(req.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await op.page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
    if (req.wait_ms) await op.page.waitForTimeout(Math.min(req.wait_ms, 10000));
    return { status: op.lastMainResponse()?.status ?? null, ...(await ws(op.page, "inspectSelector", req.selector)) };
  } finally {
    await op.close();
  }
}

export async function runProbe(req: ProbeRequest, artifact: Artifact): Promise<unknown> {
  switch (req.kind) {
    case "discover":
      return discover(req.url, artifact);
    case "extract":
      return runExtractProbe(req.config, req.max_pages, req.methods ?? [req.config.fetch.method], artifact);
    case "inspect":
      return inspect(req);
  }
}
