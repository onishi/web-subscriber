import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
// @ts-expect-error untyped fixture module
import { createFixtureServer } from "../../../packages/fixtures/src/server.mjs";
import { parseConfig, type SubscriptionConfig, type SubmittedItem } from "@ws/shared";
import { settings } from "../src/settings.js";
import { crawl, type CrawlSink, type PageInfo } from "../src/crawl.js";
import { parseFeed } from "../src/feed.js";
import { closeBrowser } from "../src/browser.js";
import { ImageEnricher, parseOgImage, TRIAL_LIMIT } from "../src/images.js";
import { parseRobots, robotsAllows, httpGet } from "../src/net.js";

let server: Server;
let base = "";

beforeAll(async () => {
  settings.allowPrivateHosts = true;
  server = createFixtureServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await closeBrowser();
  server.close();
});

async function setState(s: Record<string, unknown>) {
  await fetch(`${base}/__state`, { method: "POST", body: JSON.stringify({ itemsVersion: 1, extraItem: false, empty: false, broken: false, failPage: null, robotsDisallow: false, ogImage: false, ...s }) });
}

const itemFields = {
  title: { from: { css: "a.title" }, take: "text", required: true },
  link: { from: { css: "a.title" }, take: { attr: "href" }, required: true, transforms: [{ resolve_url: {} }] },
  published_at: { from: { css: "time" }, take: { attr: "datetime" }, transforms: [{ parse_date: {} }] },
  categories: { array: { select: { css: ".tag" }, of: { take: "text" } } },
};

function cfg(over: Record<string, unknown>): SubscriptionConfig {
  const r = parseConfig({
    schema_version: 1,
    fetch: { method: "browser" },
    extract: { items: { container: { css: "ul.news-list" }, select: { css: "ul.news-list > li.news-item" }, empty_marker: { css: ".no-result" }, fields: itemFields } },
    identity: { method: "link" },
    politeness: { min_interval_ms: 0, respect_robots_txt: true },
    ...over,
    source: { kind: "html", ...(over.source as object) },
  });
  if (!r.ok) throw new Error(r.errors.join("\n"));
  return r.config;
}

async function run(c: SubscriptionConfig, images?: ImageEnricher) {
  const pages: PageInfo[] = [];
  const items: SubmittedItem[] = [];
  const outcome = await crawl(c, {
    page: async (p) => {
      pages.push(p.page);
      items.push(...p.items);
    },
    artifact: async () => null,
  }, { images });
  return { outcome, pages, items };
}

describe("feed", () => {
  it("RSS 2.0 を意味を潰さず正規化", async () => {
    await setState({});
    const r = await httpGet(`${base}/rss.xml`, { timeoutMs: 5000 });
    const f = parseFeed(r.body, r.url);
    expect(f.format).toBe("rss2");
    const n = f.channel.native;
    expect(n.format).toBe("rss2");
    if (n.format === "rss2") {
      expect(n.ttl).toBe(60);
      expect(n.skip_hours).toEqual([0, 1]);
      expect(n.skip_days).toEqual(["Sunday"]);
      expect(n.managing_editor).toMatchObject({ email: "editor@example.com", name: "Editor Name" });
      expect(n.cloud?.register_procedure).toBe("pingMe");
      expect(n.text_input?.name).toBe("q");
      expect(n.rating).toBe("(PICS-1.1)");
    }
    expect(f.channel.authors).toEqual([]); // managingEditor を著者にしない
    expect(f.channel.links.find((l) => l.rel === "self")?.href).toBe("http://fixture.local/rss.xml");
    expect(f.channel.extensions.find((e) => e.local === "custom")).toMatchObject({ ns: "http://example.com/ns/ext", text: "channel ext" });
    const it0 = f.items[0];
    expect(it0.source_id).toBe("tag:fixture,2026:12");
    expect(it0.native).toMatchObject({ format: "rss2", guid: { is_perma_link: false }, comments: "http://fixture.local/news/12#comments", description_role: "unknown" });
    expect(it0.links.find((l) => l.rel === "enclosure")).toMatchObject({ media_type: "audio/mpeg", length_bytes: 12345 });
    expect(it0.links.find((l) => l.rel === "alternate")?.href).toBe(`${base}/news/12`);
    expect(it0.content).toMatchObject({ kind: "inline", type: "html" });
    expect(it0.published_at).toMatchObject({ value: "2026-11-12T10:00:00+09:00", tz: "explicit" });
    expect(it0.categories[0]).toEqual({ term: "info", scheme: "http://fixture.local/cat" });
    expect(it0.extensions.find((e) => e.local === "rank")?.ns).toBe("http://example.com/ns/ext");
  });

  it("Atom：id非正規化・xhtml・外部content・source・xml:base", async () => {
    const r = await httpGet(`${base}/atom.xml`, { timeoutMs: 5000 });
    const f = parseFeed(r.body, r.url);
    expect(f.format).toBe("atom");
    expect(f.channel.generator).toEqual({ name: "Gen", uri: "https://example.com/gen", version: "1.2" });
    expect(f.channel.authors[0]).toMatchObject({ name: "Feed Author", uri: "http://fixture.local/about" });
    expect(f.channel.language).toBe("ja");
    const e = f.items[0];
    expect(e.source_id).toBe("http://fixture.local/entry/12?a=1#x");
    expect(e.title).toMatchObject({ type: "html" });
    expect(e.content).toMatchObject({ kind: "inline", type: "xhtml" });
    expect((e.content as { value: string }).value).toContain("<b>xhtml</b>");
    expect(e.links[0].href).toBe("http://fixture.local/news/12");
    expect(e.published_at).toMatchObject({ value: "2026-11-12", precision: "date" });
    const ext = f.items[f.items.length - 1];
    expect(ext.content).toEqual({ kind: "external", src: "http://fixture.local/media/1.pdf", type: "application/pdf" });
    expect(ext.source?.title?.value).toBe("Other");
    expect(f.format_validation.length).toBe(0);
  });

  it("feed 購読のクロール", async () => {
    const c = parseConfig({ schema_version: 1, source: { url: `${base}/rss.xml`, kind: "feed" }, fetch: { method: "http" }, feed: { format: "auto" }, identity: { method: "source_id" }, politeness: { min_interval_ms: 0 } });
    if (!c.ok) throw new Error(c.errors.join());
    const r = await run(c.config);
    expect(r.outcome).toMatchObject({ traversal: "complete", extract_status: "success", end_reason: "single_page" });
    expect(r.items).toHaveLength(5);
    expect(r.pages[0].http_status).toBe(200);
  });

  it("フィードにロゴがなければチャンネルのリンク先の og:image を使う", async () => {
    const c = parseConfig({ schema_version: 1, source: { url: `${base}/rss.xml`, kind: "feed" }, fetch: { method: "http" }, identity: { method: "source_id" }, politeness: { min_interval_ms: 0 } });
    if (!c.ok) throw new Error(c.errors.join());
    let logo: unknown = "unset";
    const sink: CrawlSink = {
      page: async (p) => {
        logo = p.channel?.data.logo;
      },
      artifact: async () => null,
    };
    await crawl(c.config, sink);
    expect(logo).toBeUndefined();
    await setState({ ogImage: true });
    await crawl(c.config, sink);
    expect(logo).toEqual({ url: `${base}/img/news-1.jpg?a=1&b=2` });
    await setState({});
  });
});

describe("robots", () => {
  it("専用トークン優先・最長一致", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /\n\nUser-agent: Web-Subscriber\nDisallow: /private/\nAllow: /private/ok\n", "Web-Subscriber");
    expect(robotsAllows(rules, "/news")).toBe(true);
    expect(robotsAllows(rules, "/private/x")).toBe(false);
    expect(robotsAllows(rules, "/private/ok")).toBe(true);
  });
});

describe("html crawl", () => {
  it("HTTPだけで取得できるHTML", async () => {
    await setState({});
    const r = await run(cfg({ source: { url: `${base}/static/list` }, fetch: { method: "http" } }));
    expect(r.outcome).toMatchObject({ traversal: "complete", extract_status: "success", end_reason: "single_page" });
    expect(r.items).toHaveLength(12);
    expect(r.items[0].data.links[0].href).toBe(`${base}/news/12`);
    expect(r.items[0].data.published_at?.value).toBe("2026-11-12");
    expect(r.pages[0]).toMatchObject({ http_status: 200, http_status_source: "main_document" });
  });

  it("JS後に一覧が出るページ：http方式では抽出失敗、browser方式で成功", async () => {
    const h = await run(cfg({ source: { url: `${base}/js/list` }, fetch: { method: "http" } }));
    expect(h.outcome).toMatchObject({ extract_status: "failed", error_stage: "extract" });
    const b = await run(
      cfg({
        source: { url: `${base}/js/list` },
        wait: { initial: { cond: { any: [{ exists: { css: "ul.news-list" } }, { exists: { css: ".no-result" } }] }, timeout_ms: 5000 } },
      }),
    );
    expect(b.outcome).toMatchObject({ traversal: "complete", extract_status: "success" });
    expect(b.items).toHaveLength(12);
  });

  it("次へクリックで置換（replace）", async () => {
    const r = await run(
      cfg({
        source: { url: `${base}/replace` },
        wait: {
          initial: { cond: { all: [{ exists: { css: "ul.news-list > li" } }, { stable: { target: { css: ".list-wrap" }, for_ms: 300 } }] }, timeout_ms: 5000 },
          after_paging: { cond: { all: [{ items_changed: {} }, { exists: { css: "ul.news-list > li" } }, { stable: { target: { css: ".list-wrap" }, for_ms: 300 } }] }, timeout_ms: 5000 },
        },
        paging: { mode: "replace", next: { css: "button.next" } },
      }),
    );
    expect(r.outcome).toMatchObject({ traversal: "complete", end_reason: "next_disabled", actions_performed: 2 });
    expect(r.items).toHaveLength(12);
    expect(r.pages.map((p) => p.kind)).toEqual(["initial", "click_replace", "click_replace"]);
    expect(r.pages[1]).toMatchObject({ http_status: null, http_status_source: "none", action_result: "clicked" });
  });

  it("リンク遷移の replace と途中ページ失敗", async () => {
    const c = cfg({ source: { url: `${base}/paged` }, paging: { mode: "replace", next: { css: "a.next" } } });
    const ok = await run(c);
    expect(ok.outcome).toMatchObject({ traversal: "complete", end_reason: "no_next" });
    expect(ok.pages[1]).toMatchObject({ kind: "navigate", http_status: 200, http_status_source: "main_document" });
    expect(ok.items).toHaveLength(12);
    await setState({ failPage: 2 });
    const bad = await run(c);
    expect(bad.outcome).toMatchObject({ traversal: "incomplete", error_stage: "fetch", extract_status: "success" });
    expect(bad.items).toHaveLength(5);
    expect(bad.pages[1].http_status).toBe(500);
    await setState({});
  });

  it("もっと見る（append）", async () => {
    const r = await run(
      cfg({
        source: { url: `${base}/append` },
        wait: {
          initial: { cond: { item_count_at_least: 1 }, timeout_ms: 5000 },
          after_paging: { cond: { all: [{ item_count_changed: {} }, { stable: { target: { css: "ul.news-list" }, for_ms: 300 } }] }, timeout_ms: 5000 },
        },
        paging: { mode: "append", next: { css: "button.more" } },
      }),
    );
    expect(r.outcome).toMatchObject({ traversal: "complete", end_reason: "no_next" });
    expect(r.items).toHaveLength(12);
    expect(new Set(r.items.map((i) => i.identity_key)).size).toBe(12);
    expect(r.pages.slice(1).every((p) => p.kind === "click_append")).toBe(true);
  });

  it("待機タイムアウト", async () => {
    const r = await run(cfg({ source: { url: `${base}/js/list` }, wait: { initial: { cond: { exists: { css: ".never" } }, timeout_ms: 500 } } }));
    expect(r.outcome).toMatchObject({ traversal: "incomplete", end_reason: "wait_timeout", error_stage: "wait" });
  });

  it("正常0件と破損の区別", async () => {
    await setState({ empty: true });
    const e = await run(cfg({ source: { url: `${base}/static/list` }, fetch: { method: "http" } }));
    expect(e.outcome).toMatchObject({ traversal: "complete", extract_status: "success" });
    expect(e.items).toHaveLength(0);
    await setState({ broken: true });
    const b = await run(cfg({ source: { url: `${base}/static/list` }, fetch: { method: "http" } }));
    expect(b.outcome).toMatchObject({ traversal: "incomplete", extract_status: "failed" });
    expect(b.pages[0].error).toBe("container_not_found");
    await setState({});
  });

  it("HTTPエラー", async () => {
    const r = await run(cfg({ source: { url: `${base}/error/500` }, fetch: { method: "http" } }));
    expect(r.outcome).toMatchObject({ error_stage: "fetch", retryable: true, extract_status: "skipped" });
    expect(r.pages[0].http_status).toBe(500);
    const b = await run(cfg({ source: { url: `${base}/error/404` } }));
    expect(b.outcome).toMatchObject({ error_stage: "fetch", retryable: false });
    expect(b.pages[0].http_status).toBe(404);
  });

  it("循環と次へ複数一致", async () => {
    const c = await run(cfg({ source: { url: `${base}/cycle` }, paging: { mode: "replace", next: { css: "a.next" } } }));
    expect(c.outcome.end_reason).toBe("cycle_detected");
    const m = await run(cfg({ source: { url: `${base}/multi-next` }, paging: { mode: "replace", next: { css: "a.next" } } }));
    expect(m.outcome).toMatchObject({ end_reason: "config_error", error_stage: "paging" });
    const m2 = await run(cfg({ source: { url: `${base}/multi-next` }, paging: { mode: "replace", next: { css: "a.next" }, pick: "first", limits: { max_pages: 2, max_actions: 5, max_duration_ms: 60000 } } }));
    expect(m2.outcome).toMatchObject({ end_reason: "cycle_detected", actions_performed: 1 }); // pick:first でクリックできる（同一一覧のため循環終了）
  });

  it("robots.txt に従う", async () => {
    await setState({ robotsDisallow: true });
    // robots はオリジン単位で24hキャッシュされるため別オリジン(localhost)で確認
    const u = `${base.replace("127.0.0.1", "localhost")}/static/list`;
    const r = await run(cfg({ source: { url: u }, fetch: { method: "http" } }));
    expect(r.outcome).toMatchObject({ end_reason: "robots_disallowed", error_stage: "robots" });
    await setState({});
  });
});

describe("item images (og:image)", () => {
  it("parses og:image / twitter:image from head", () => {
    expect(parseOgImage(`<html><head><meta property="og:image" content="/a.png"></head>`, "https://ex.com/p/1")).toBe("https://ex.com/a.png");
    expect(parseOgImage(`<head><meta content='https://cdn.ex.com/x.jpg?a=1&amp;b=2' property='og:image'/></head>`, "https://ex.com/")).toBe("https://cdn.ex.com/x.jpg?a=1&b=2");
    expect(parseOgImage(`<head><meta name="twitter:image" content="//cdn.ex.com/t.jpg"></head>`, "https://ex.com/")).toBe("https://cdn.ex.com/t.jpg");
    expect(parseOgImage(`<head><title>x</title></head><body><meta property="og:image" content="/late.png"></body>`, "https://ex.com/")).toBeNull();
    expect(parseOgImage(`<head><meta property="og:image" content="javascript:alert(1)"></head>`, "https://ex.com/")).toBeNull();
  });

  const listCfg = () => cfg({ source: { url: `${base}/static/list` }, fetch: { method: "http" } });

  it("trial: finds og:image and keeps going for the rest", async () => {
    await setState({ ogImage: true });
    const images = new ImageEnricher({ mode: "trial", skip_keys: [] }, { minIntervalMs: 0, respectRobots: true });
    const r = await run(listCfg(), images);
    const looked = r.items.filter((i) => i.image_lookup);
    expect(looked.length).toBe(r.items.length);
    expect(looked[0].image_lookup!.url).toMatch(/\/img\/news-\d+\.jpg\?a=1&b=2$/);
    expect(images.stats()).toMatchObject({ mode: "trial", found: r.items.length, tried: r.items.length });
    await setState({});
  });

  it("trial: gives up after a few misses", async () => {
    const images = new ImageEnricher({ mode: "trial", skip_keys: [] }, { minIntervalMs: 0, respectRobots: true });
    const r = await run(listCfg(), images);
    expect(images.stats()).toMatchObject({ tried: TRIAL_LIMIT, found: 0 });
    expect(r.items.filter((i) => i.image_lookup).every((i) => i.image_lookup!.url === null)).toBe(true);
  });

  it("on: skips items already checked", async () => {
    await setState({ ogImage: true });
    const first = await run(listCfg());
    const skip = first.items.slice(0, 2).map((i) => i.identity_key!);
    const images = new ImageEnricher({ mode: "on", skip_keys: skip }, { minIntervalMs: 0, respectRobots: true });
    const r = await run(listCfg(), images);
    expect(r.items.filter((i) => skip.includes(i.identity_key!)).every((i) => !i.image_lookup)).toBe(true);
    expect(images.stats().tried).toBe(r.items.length - 2);
    await setState({});
  });
});
