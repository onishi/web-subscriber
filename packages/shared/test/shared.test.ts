import { describe, it, expect } from "vitest";
import { JSDOM } from "jsdom";
import { parseDate, sortKey } from "../src/date.js";
import { parseConfig } from "../src/config.js";
import { identityKey, itemContentHash, canonicalJson, channelContentHash } from "../src/hash.js";
import { decideRunOutcome } from "../src/protocol.js";
import { emptyItem, emptyChannel, itemImageFromData } from "../src/model.js";
import { extractPage, evalRule } from "../src/dom/extract.js";
import { applyTransforms } from "../src/transforms.js";

describe("parseDate", () => {
  it("日付のみには時刻を付けない", () => {
    const d = parseDate("2026.11.16", { assume_tz: "Asia/Tokyo" });
    expect(d).toMatchObject({ value: "2026-11-16", precision: "date", tz: "none" });
    expect(parseDate("2026年11月6日")).toMatchObject({ value: "2026-11-06", precision: "date" });
    expect(parseDate("2026-11-16")).toMatchObject({ value: "2026-11-16", precision: "date" });
  });
  it("RFC822 と RFC3339 の明示TZ", () => {
    expect(parseDate("Mon, 16 Nov 2026 10:00:00 +0900")).toMatchObject({ value: "2026-11-16T10:00:00+09:00", tz: "explicit", precision: "datetime" });
    expect(parseDate("Mon, 16 Nov 2026 01:00:00 GMT")).toMatchObject({ value: "2026-11-16T01:00:00Z", tz: "explicit" });
    expect(parseDate("2026-11-16T12:00:00Z").value).toBe("2026-11-16T12:00:00Z");
  });
  it("TZなし時刻は補完を明示", () => {
    expect(parseDate("2026/11/16 10:30", { assume_tz: "Asia/Tokyo" })).toMatchObject({ value: "2026-11-16T10:30:00+09:00", tz: "assumed", assumed_tz: "Asia/Tokyo" });
    expect(parseDate("2026-11-16T10:30:00")).toMatchObject({ tz: "none", value: "2026-11-16T10:30:00" });
  });
  it("書式指定・不正値", () => {
    expect(parseDate("16/11/2026", { formats: ["dd/MM/yyyy"] }).value).toBe("2026-11-16");
    expect(parseDate("2026-02-30").value).toBeNull();
    expect(parseDate("昨日").parse_error).toBe("unrecognized_format");
  });
  it("sortKey は日付のみなら日付のみ", () => {
    expect(sortKey(parseDate("2026-11-16"))).toBe("2026-11-16");
    expect(sortKey(parseDate("2026-11-16T10:00:00+09:00"))).toBe("2026-11-16T01:00:00.000Z");
  });
});

const baseCfg = {
  schema_version: 1,
  source: { url: "https://example.com/news/", kind: "html" },
  fetch: { method: "http" },
  extract: {
    items: {
      container: { css: "ul.news" },
      select: { css: "ul.news > li" },
      empty_marker: { css: ".none" },
      fields: {
        title: { from: { css: "a" }, take: "text", required: true, transforms: ["collapse_whitespace"] },
        link: { from: { css: "a" }, take: { attr: "href" }, required: true, transforms: [{ resolve_url: {} }] },
        published_at: { from: { css: "time" }, transforms: [{ parse_date: {} }] },
        categories: { array: { select: { css: ".tag" }, of: { take: "text", transforms: ["trim"] } } },
        price: { from: { xpath: ".//span[@class='p']" }, transforms: ["parse_int"] },
      },
    },
  },
  identity: { method: "link" },
};

function doc(html: string) {
  return new JSDOM(html, { url: "https://example.com/news/" }).window.document;
}

describe("config", () => {
  it("検証エラーを返す", () => {
    const r = parseConfig({ ...baseCfg, paging: { mode: "append" } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/paging.next|browser/);
  });
});

describe("extractPage", () => {
  const cfg = (() => {
    const r = parseConfig(baseCfg);
    if (!r.ok) throw new Error(r.errors.join());
    return r.config;
  })();
  const env = (d: Document) => ({ doc: d, baseUrl: "https://example.com/news/", timezone: "Asia/Tokyo" });

  it("item抽出・相対URL解決・配列・XPath", () => {
    const d = doc(`<ul class="news"><li><a href="/a/1"> A  1 </a><time>2026.11.01</time><span class="tag">x</span><span class="tag">y</span><span class="p">1,200</span></li><li><a href="2">B</a></li></ul>`);
    const r = extractPage(cfg, env(d));
    expect(r.status).toBe("success");
    expect(r.items).toHaveLength(2);
    const a = r.items[0].data;
    expect(a.title).toEqual({ type: "text", value: "A 1" });
    expect(a.links[0].href).toBe("https://example.com/a/1");
    expect(a.published_at?.value).toBe("2026-11-01");
    expect(a.categories.map((c) => c.term)).toEqual(["x", "y"]);
    expect(a.native.format === "html" && a.native.extracted_fields.price).toBe(1200);
    expect(r.items[1].data.links[0].href).toBe("https://example.com/news/2");
    expect(r.field_failures.published_at.no_match).toBe(1);
  });
  it("ページの og:image をチャンネルのロゴにする", () => {
    const d = new JSDOM(`<html><head><meta property="og:image" content="/img/ogp.png"></head><body><ul class="news"></ul></body></html>`).window.document;
    expect(extractPage(cfg, env(d)).channel?.logo?.url).toBe("https://example.com/img/ogp.png");
    expect(extractPage(cfg, env(doc(`<ul class="news"></ul>`))).channel?.logo).toBeUndefined();
  });
  it("正常0件と構造破損を区別", () => {
    expect(extractPage(cfg, env(doc(`<ul class="news"></ul><p class="none">なし</p>`)))).toMatchObject({ status: "success", items: [] });
    expect(extractPage(cfg, env(doc(`<ul class="news"></ul>`)))).toMatchObject({ status: "success" });
    expect(extractPage(cfg, env(doc(`<div class="renewal"><p>x</p></div>`)))).toMatchObject({ status: "failed", reason: "container_not_found" });
  });
  it("必須欠落が閾値を超えると失敗", () => {
    const r = extractPage(cfg, env(doc(`<ul class="news"><li><span>no link</span></li><li><a href="/x">x</a></li></ul>`)));
    expect(r.status).toBe("failed");
    expect(r.invalid_items).toBe(1);
  });
  it("単数指定で複数一致はエラー、first 明示で先頭採用、fallback は no_match のみ", () => {
    const d = doc(`<div id="r"><a href="/1">1</a><a href="/2">2</a></div>`);
    const root = d.getElementById("r")!;
    const e = env(d);
    expect(evalRule({ from: { css: "a" } }, root, e)).toMatchObject({ status: "error" });
    expect(evalRule({ from: { css: "a" }, cardinality: "first" }, root, e)).toMatchObject({ status: "ok", value: "1" });
    expect(evalRule({ from: { css: "b" }, fallback: [{ const: "fb" }] }, root, e)).toMatchObject({ status: "ok", value: "fb", used: 1 });
    expect(evalRule({ from: { css: "a" }, fallback: [{ const: "fb" }] }, root, e)).toMatchObject({ status: "error" });
    expect(evalRule({ from: { css: "a" }, take: { attr: "data-x" }, cardinality: "first" }, root, e)).toMatchObject({ status: "no_match" });
    expect(evalRule({ from: { css: "div" }, take: "text", cardinality: "first", transforms: [{ regex_extract: { pattern: "zzz", group: 0 } }] }, d, e)).toMatchObject({ status: "empty" });
  });
});

describe("transforms", () => {
  it("default/join", () => {
    const env = { baseUrl: "https://e.com/", timezone: "UTC" };
    expect(applyTransforms(["a", "b"], [{ join: { sep: "," } }], env)).toEqual({ ok: true, value: "a,b" });
    expect(applyTransforms("", ["trim", { default: { value: "x" } }], env)).toEqual({ ok: true, value: "x" });
  });
});

describe("identity / hash", () => {
  it("source_id は URL に見えても正規化しない", async () => {
    const it1 = { ...emptyItem({ format: "atom" }), source_id: "http://EXAMPLE.com/a#x" };
    expect(await identityKey(it1, { method: "source_id", fields: [], link_normalization: ["strip_fragment"] })).toEqual({ ok: true, key: "http://EXAMPLE.com/a#x" });
  });
  it("link 方式は明示した正規化のみ", async () => {
    const it1 = { ...emptyItem({ format: "atom" }), links: [{ href: "https://e.com/a?x=1#f", rel: "alternate" }] };
    expect(await identityKey(it1, { method: "link", fields: [], link_normalization: ["strip_fragment"] })).toEqual({ ok: true, key: "https://e.com/a?x=1" });
  });
  it("ハッシュは掲載順・位置に依存せず内容で変わる", async () => {
    const a = { ...emptyItem({ format: "atom" }), title: { type: "text" as const, value: "x" }, categories: [] };
    const b = { ...a, title: { type: "text" as const, value: "x" }, contributors: [] };
    const fields = ["title", "links", "categories"];
    expect(await itemContentHash(a, fields)).toBe(await itemContentHash(b, fields));
    expect(await itemContentHash({ ...a, title: { type: "text", value: "y" } }, fields)).not.toBe(await itemContentHash(a, fields));
    expect(canonicalJson({ b: 1, a: [], c: "" })).toBe('{"b":1}');
  });
});

describe("decideRunOutcome", () => {
  const base = { baselineStatusBefore: "complete" as const, traversal: "complete" as const, extractStatus: "success" as const, fatal: false, newItems: 0, updatedItems: 0, channelChanged: false, anyDataObtained: true, rebaseline: false };
  it("初回", () => {
    expect(decideRunOutcome({ ...base, baselineStatusBefore: "none" })).toMatchObject({ changeStatus: "initial", baselineStatusAfter: "complete", runStatus: "completed" });
    expect(decideRunOutcome({ ...base, baselineStatusBefore: "none", traversal: "incomplete" })).toMatchObject({ changeStatus: "initial", baselineStatusAfter: "partial", baselineIncomplete: true, runStatus: "partial" });
    expect(decideRunOutcome({ ...base, baselineStatusBefore: "none", anyDataObtained: false, extractStatus: "failed" })).toMatchObject({ changeStatus: "unknown", runStatus: "failed" });
  });
  it("抽出失敗は変更なしにしない", () => {
    expect(decideRunOutcome({ ...base, extractStatus: "failed", traversal: "incomplete", anyDataObtained: false })).toMatchObject({ changeStatus: "unknown", runStatus: "failed" });
  });
  it("途中失敗でも変更を検出すれば changed", () => {
    expect(decideRunOutcome({ ...base, traversal: "incomplete", newItems: 1 })).toMatchObject({ changeStatus: "changed", runStatus: "partial" });
    expect(decideRunOutcome({ ...base, traversal: "incomplete" })).toMatchObject({ changeStatus: "unknown" });
    expect(decideRunOutcome(base)).toMatchObject({ changeStatus: "unchanged", runStatus: "completed" });
  });
});

describe("itemImageFromData", () => {
  const base = () => emptyItem({ format: "rss2" });
  it("uses image enclosure", () => {
    const it = base();
    it.links.push({ href: "https://ex.com/a.mp3", rel: "enclosure", media_type: "audio/mpeg" }, { href: "https://ex.com/a.jpg", rel: "enclosure", media_type: "image/jpeg" });
    expect(itemImageFromData(it)).toBe("https://ex.com/a.jpg");
  });
  it("uses media:thumbnail / media:content", () => {
    const it = base();
    const M = "http://search.yahoo.com/mrss/";
    it.extensions.push({ ns: M, local: "content", attrs: [{ ns: null, local: "url", value: "https://ex.com/v.mp4" }, { ns: null, local: "medium", value: "video" }], xml: "" });
    expect(itemImageFromData(it)).toBeUndefined();
    it.extensions.push({ ns: M, local: "group", attrs: [], xml: "", children: [{ ns: M, local: "thumbnail", attrs: [{ ns: null, local: "url", value: "https://ex.com/t.jpg" }], xml: "" }] });
    expect(itemImageFromData(it)).toBe("https://ex.com/t.jpg");
  });
  it("uses extracted image field for html", () => {
    const it = emptyItem({ format: "html", extracted_fields: { image: "https://ex.com/i.png" } });
    expect(itemImageFromData(it)).toBe("https://ex.com/i.png");
    expect(itemImageFromData(base())).toBeUndefined();
  });
});

describe("channelContentHash", () => {
  it("ignores logo/icon", async () => {
    const a = emptyChannel({ format: "atom" });
    a.title = { type: "text", value: "t" };
    const b = { ...a, logo: { url: "https://ex.com/l.png" }, icon: { url: "https://ex.com/i.png" } };
    expect(await channelContentHash(a)).toBe(await channelContentHash(b));
  });
});
