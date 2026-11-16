// RSS 2.0 / RSS 1.0 (RDF) / Atom を共通モデルへ正規化する（docs/design.md §2）。
// 元XMLの完全再現は生XMLの保存で担保し、ここでは意味を潰さない正規化を行う。
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import {
  type ChannelData,
  type ItemData,
  type Text,
  type Person,
  type Link,
  type Category,
  type Image,
  type Extension,
  type Content,
  type ValidationIssue,
  type SourceChannel,
  emptyChannel,
  emptyItem,
  parseDate,
} from "@ws/shared";

export const NS = {
  atom: "http://www.w3.org/2005/Atom",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rss1: "http://purl.org/rss/1.0/",
  content: "http://purl.org/rss/1.0/modules/content/",
  dc: "http://purl.org/dc/elements/1.1/",
  xml: "http://www.w3.org/XML/1998/namespace",
  xhtml: "http://www.w3.org/1999/xhtml",
};

type El = Element;

export interface ParsedFeed {
  format: "rss2" | "rss1" | "atom";
  channel: ChannelData;
  items: ItemData[];
  format_validation: ValidationIssue[];
}

const ser = new XMLSerializer();

function children(el: El): El[] {
  const out: El[] = [];
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) out.push(n as El);
  return out;
}
function kids(el: El, ns: string | null, local: string): El[] {
  return children(el).filter((c) => (c.namespaceURI ?? null) === ns && c.localName === local);
}
function kid(el: El, ns: string | null, local: string): El | undefined {
  return kids(el, ns, local)[0];
}
function text(el: El | undefined): string | undefined {
  if (!el) return undefined;
  return el.textContent ?? "";
}
function trimmed(el: El | undefined): string | undefined {
  const t = text(el)?.trim();
  return t ? t : undefined;
}

function xmlBase(el: El, docUrl: string): string {
  const chain: string[] = [];
  for (let n: Node | null = el; n && n.nodeType === 1; n = n.parentNode) {
    const b = (n as El).getAttributeNS(NS.xml, "base");
    if (b) chain.unshift(b);
  }
  let base = docUrl;
  for (const b of chain) {
    try {
      base = new URL(b, base).toString();
    } catch {
      /* ignore */
    }
  }
  return base;
}
function xmlLang(el: El): string | undefined {
  for (let n: Node | null = el; n && n.nodeType === 1; n = n.parentNode) {
    const l = (n as El).getAttributeNS(NS.xml, "lang");
    if (l) return l;
  }
  return undefined;
}
function resolve(href: string, base: string): string {
  try {
    return new URL(href.trim(), base).toString();
  } catch {
    return href.trim();
  }
}

function toExtension(el: El): Extension {
  const attrs = [];
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i];
    if (a.name === "xmlns" || a.name.startsWith("xmlns:")) continue;
    attrs.push({ ns: a.namespaceURI ?? null, local: a.localName ?? a.name, value: a.value });
  }
  const ch = children(el);
  return {
    ns: el.namespaceURI ?? null,
    prefix: el.prefix ?? undefined,
    local: el.localName ?? el.nodeName,
    attrs,
    text: ch.length ? undefined : (el.textContent ?? ""),
    children: ch.length ? ch.map(toExtension) : undefined,
    xml: ser.serializeToString(el as never),
  };
}

function innerXml(el: El): string {
  let s = "";
  for (let n = el.firstChild; n; n = n.nextSibling) s += ser.serializeToString(n as never);
  return s;
}

/** Atom Text construct */
function atomText(el: El | undefined, docUrl: string): Text | undefined {
  if (!el) return undefined;
  const type = (el.getAttribute("type") || "text") as string;
  const lang = xmlLang(el);
  const base = xmlBase(el, docUrl);
  if (type === "xhtml") {
    const div = kid(el, NS.xhtml, "div");
    return { type: "xhtml", value: div ? innerXml(div) : innerXml(el), lang, base };
  }
  return { type: type === "html" ? "html" : "text", value: el.textContent ?? "", lang, base };
}

function atomPerson(el: El, docUrl: string): Person {
  const uri = trimmed(kid(el, NS.atom, "uri"));
  return {
    name: trimmed(kid(el, NS.atom, "name")),
    email: trimmed(kid(el, NS.atom, "email")),
    uri: uri ? resolve(uri, xmlBase(el, docUrl)) : undefined,
  };
}

function atomLink(el: El, docUrl: string): Link {
  const href = el.getAttribute("href") ?? "";
  const len = el.getAttribute("length");
  return {
    href: resolve(href, xmlBase(el, docUrl)),
    href_raw: href,
    rel: el.getAttribute("rel") || "alternate",
    media_type: el.getAttribute("type") || undefined,
    hreflang: el.getAttribute("hreflang") || undefined,
    title: el.getAttribute("title") || undefined,
    length_bytes: len && /^\d+$/.test(len) ? Number(len) : undefined,
  };
}

function atomCategory(el: El): Category {
  return { term: el.getAttribute("term") ?? "", scheme: el.getAttribute("scheme") || undefined, label: el.getAttribute("label") || undefined };
}

function atomContent(el: El | undefined, docUrl: string): Content | undefined {
  if (!el) return undefined;
  const type = el.getAttribute("type") || "text";
  const src = el.getAttribute("src");
  if (src) return { kind: "external", src: resolve(src, xmlBase(el, docUrl)), type: el.getAttribute("type") || undefined };
  const lang = xmlLang(el);
  const base = xmlBase(el, docUrl);
  if (type === "text" || type === "html") return { kind: "inline", type, value: el.textContent ?? "", lang, base };
  if (type === "xhtml") {
    const div = kid(el, NS.xhtml, "div");
    return { kind: "inline", type: "xhtml", value: div ? innerXml(div) : innerXml(el), lang, base };
  }
  // 任意MIME：XML系は子要素をそのまま、text/* はテキスト、その他は base64
  if (/[+/]xml$/i.test(type)) return { kind: "inline", type, value: innerXml(el), lang, base };
  if (/^text\//i.test(type)) return { kind: "inline", type, value: el.textContent ?? "", lang, base };
  return { kind: "inline", type, value: (el.textContent ?? "").replace(/\s+/g, ""), encoding: "base64", lang, base };
}

const ATOM_FEED_KNOWN = new Set(["id", "title", "subtitle", "link", "updated", "author", "contributor", "category", "rights", "icon", "logo", "generator", "entry"]);

function parseAtomFeedMeta(feed: El, docUrl: string, issues: ValidationIssue[], forSource = false): ChannelData {
  const ch = emptyChannel({ format: "atom" });
  ch.source_id = text(kid(feed, NS.atom, "id"))?.trim();
  ch.title = atomText(kid(feed, NS.atom, "title"), docUrl);
  ch.description = atomText(kid(feed, NS.atom, "subtitle"), docUrl);
  ch.links = kids(feed, NS.atom, "link").map((l) => atomLink(l, docUrl));
  ch.language = xmlLang(feed);
  ch.authors = kids(feed, NS.atom, "author").map((p) => atomPerson(p, docUrl));
  ch.contributors = kids(feed, NS.atom, "contributor").map((p) => atomPerson(p, docUrl));
  ch.categories = kids(feed, NS.atom, "category").map(atomCategory);
  ch.rights = atomText(kid(feed, NS.atom, "rights"), docUrl);
  const upd = trimmed(kid(feed, NS.atom, "updated"));
  if (upd) ch.updated_at = parseDate(upd);
  const icon = trimmed(kid(feed, NS.atom, "icon"));
  if (icon) ch.icon = { url: resolve(icon, xmlBase(feed, docUrl)) };
  const logo = trimmed(kid(feed, NS.atom, "logo"));
  if (logo) ch.logo = { url: resolve(logo, xmlBase(feed, docUrl)) };
  const gen = kid(feed, NS.atom, "generator");
  if (gen) ch.generator = { name: (gen.textContent ?? "").trim(), uri: gen.getAttribute("uri") || undefined, version: gen.getAttribute("version") || undefined };
  ch.extensions = children(feed)
    .filter((c) => c.namespaceURI !== NS.atom || !ATOM_FEED_KNOWN.has(c.localName ?? ""))
    .map(toExtension);
  if (!forSource) {
    if (!ch.source_id) issues.push({ level: "warning", code: "atom_feed_id_missing", message: "atom:feed に id がない" });
    if (!ch.title) issues.push({ level: "warning", code: "atom_feed_title_missing", message: "atom:feed に title がない" });
    if (!upd) issues.push({ level: "warning", code: "atom_feed_updated_missing", message: "atom:feed に updated がない" });
  }
  return ch;
}

const ATOM_ENTRY_KNOWN = new Set(["id", "title", "link", "summary", "content", "author", "contributor", "category", "rights", "published", "updated", "source"]);

function parseAtom(feed: El, docUrl: string): ParsedFeed {
  const issues: ValidationIssue[] = [];
  const channel = parseAtomFeedMeta(feed, docUrl, issues);
  const items = kids(feed, NS.atom, "entry").map((e, i) => {
    const it = emptyItem({ format: "atom" });
    const id = text(kid(e, NS.atom, "id"));
    // Atom id は厳密な文字列比較。URL正規化はしない（前後空白のみ除去：RFC 4287 の IRI は空白を含まない）
    it.source_id = id?.trim() || undefined;
    it.title = atomText(kid(e, NS.atom, "title"), docUrl);
    it.links = kids(e, NS.atom, "link").map((l) => atomLink(l, docUrl));
    it.summary = atomText(kid(e, NS.atom, "summary"), docUrl);
    it.content = atomContent(kid(e, NS.atom, "content"), docUrl);
    it.authors = kids(e, NS.atom, "author").map((p) => atomPerson(p, docUrl));
    it.contributors = kids(e, NS.atom, "contributor").map((p) => atomPerson(p, docUrl));
    it.categories = kids(e, NS.atom, "category").map(atomCategory);
    it.rights = atomText(kid(e, NS.atom, "rights"), docUrl);
    it.language = xmlLang(e);
    const pub = trimmed(kid(e, NS.atom, "published"));
    if (pub) it.published_at = parseDate(pub);
    const upd = trimmed(kid(e, NS.atom, "updated"));
    if (upd) it.updated_at = parseDate(upd);
    const src = kid(e, NS.atom, "source");
    if (src) {
      const s = parseAtomFeedMeta(src, docUrl, issues, true);
      it.source = s as SourceChannel;
    }
    it.extensions = children(e)
      .filter((c) => c.namespaceURI !== NS.atom || !ATOM_ENTRY_KNOWN.has(c.localName ?? ""))
      .map(toExtension);
    if (!it.source_id) issues.push({ level: "warning", code: "atom_entry_id_missing", message: "entry に id がない", path: `entry[${i}]` });
    if (!upd) issues.push({ level: "warning", code: "atom_entry_updated_missing", message: "entry に updated がない", path: `entry[${i}]` });
    if (!it.title) issues.push({ level: "warning", code: "atom_entry_title_missing", message: "entry に title がない", path: `entry[${i}]` });
    return it;
  });
  return { format: "atom", channel, items, format_validation: issues };
}

/** RSS の "email (Name)" 形式 */
export function rssPerson(raw: string): Person {
  const s = raw.trim();
  const m = /^([^\s()]+@[^\s()]+)\s*\(([^)]*)\)$/.exec(s);
  if (m) return { email: m[1], name: m[2].trim() || undefined, raw: s };
  if (/^[^\s@]+@[^\s@]+$/.test(s)) return { email: s, raw: s };
  return { name: s, raw: s };
}

function rssImage(el: El | undefined, ns: string | null, docUrl: string): Image | undefined {
  if (!el) return undefined;
  const url = trimmed(kid(el, ns, "url")) ?? el.getAttributeNS(NS.rdf, "resource") ?? undefined;
  if (!url) return undefined;
  const w = trimmed(kid(el, ns, "width"));
  const h = trimmed(kid(el, ns, "height"));
  return {
    url: resolve(url, docUrl),
    title: trimmed(kid(el, ns, "title")),
    link: trimmed(kid(el, ns, "link")),
    description: trimmed(kid(el, ns, "description")),
    width: w && /^\d+$/.test(w) ? Number(w) : undefined,
    height: h && /^\d+$/.test(h) ? Number(h) : undefined,
  };
}

function rssTextInput(el: El | undefined, ns: string | null) {
  if (!el) return undefined;
  return { title: trimmed(kid(el, ns, "title")), description: trimmed(kid(el, ns, "description")), name: trimmed(kid(el, ns, "name")), link: trimmed(kid(el, ns, "link")) };
}

/** RSS内で共通モデルに写像する既知拡張（元要素は extensions にも保持する） */
function applyKnownExtensions(target: ChannelData | ItemData, el: El, docUrl: string, isItem: boolean) {
  for (const l of kids(el, NS.atom, "link")) target.links.push(atomLink(l, docUrl));
  for (const c of kids(el, NS.dc, "creator")) {
    const t = trimmed(c);
    if (t) target.authors.push({ name: t });
  }
  for (const c of kids(el, NS.dc, "contributor")) {
    const t = trimmed(c);
    if (t) target.contributors.push({ name: t });
  }
  for (const c of kids(el, NS.dc, "subject")) {
    const t = trimmed(c);
    if (t) target.categories.push({ term: t });
  }
  const dcDate = trimmed(kid(el, NS.dc, "date"));
  if (dcDate && !target.published_at) target.published_at = parseDate(dcDate);
  const dcRights = trimmed(kid(el, NS.dc, "rights"));
  if (dcRights && !target.rights) target.rights = { type: "text", value: dcRights };
  const dcLang = trimmed(kid(el, NS.dc, "language"));
  if (dcLang && !target.language) target.language = dcLang;
  if (isItem) {
    const enc = kid(el, NS.content, "encoded");
    if (enc) (target as ItemData).content = { kind: "inline", type: "html", value: enc.textContent ?? "" };
    const dcId = trimmed(kid(el, NS.dc, "identifier"));
    if (dcId && !(target as ItemData).source_id) (target as ItemData).source_id = dcId;
  }
}

const RSS2_CH_KNOWN = new Set(["title", "link", "description", "language", "copyright", "managingEditor", "webMaster", "pubDate", "lastBuildDate", "category", "generator", "docs", "cloud", "ttl", "image", "rating", "textInput", "skipHours", "skipDays", "item"]);
const RSS2_ITEM_KNOWN = new Set(["title", "link", "description", "author", "category", "comments", "enclosure", "guid", "pubDate", "source"]);

function parseRss2(rss: El, docUrl: string): ParsedFeed {
  const issues: ValidationIssue[] = [];
  const c = kid(rss, null, "channel");
  if (!c) throw new Error("rss_channel_missing");
  const ch = emptyChannel({ format: "rss2" });
  const desc = text(kid(c, null, "description"));
  ch.title = kid(c, null, "title") ? { type: "text", value: text(kid(c, null, "title"))! } : undefined;
  ch.description = desc !== undefined ? { type: "html", value: desc } : undefined;
  const link = trimmed(kid(c, null, "link"));
  if (link) ch.links.push({ href: resolve(link, docUrl), href_raw: link, rel: "alternate" });
  ch.language = trimmed(kid(c, null, "language"));
  const copy = text(kid(c, null, "copyright"));
  if (copy !== undefined) ch.rights = { type: "text", value: copy };
  const pub = trimmed(kid(c, null, "pubDate"));
  if (pub) ch.published_at = parseDate(pub);
  const lbd = trimmed(kid(c, null, "lastBuildDate"));
  if (lbd) ch.updated_at = parseDate(lbd);
  ch.categories = kids(c, null, "category").map((e) => ({ term: (e.textContent ?? "").trim(), scheme: e.getAttribute("domain") || undefined }));
  const gen = trimmed(kid(c, null, "generator"));
  if (gen) ch.generator = { name: gen };
  const image = rssImage(kid(c, null, "image"), null, docUrl);
  if (image) ch.logo = image;
  const cloudEl = kid(c, null, "cloud");
  const ttl = trimmed(kid(c, null, "ttl"));
  const me = trimmed(kid(c, null, "managingEditor"));
  const wm = trimmed(kid(c, null, "webMaster"));
  const sh = kid(c, null, "skipHours");
  const sd = kid(c, null, "skipDays");
  ch.native = {
    format: "rss2",
    version: rss.getAttribute("version") || undefined,
    ttl: ttl && /^\d+$/.test(ttl) ? Number(ttl) : undefined,
    skip_hours: sh ? kids(sh, null, "hour").map((h) => Number(trimmed(h))).filter((n) => Number.isFinite(n)) : undefined,
    skip_days: sd ? kids(sd, null, "day").map((d) => trimmed(d) ?? "").filter(Boolean) : undefined,
    cloud: cloudEl
      ? {
          domain: cloudEl.getAttribute("domain") || undefined,
          port: cloudEl.getAttribute("port") ? Number(cloudEl.getAttribute("port")) : undefined,
          path: cloudEl.getAttribute("path") || undefined,
          register_procedure: cloudEl.getAttribute("registerProcedure") || undefined,
          protocol: cloudEl.getAttribute("protocol") || undefined,
        }
      : undefined,
    // managingEditor / webMaster は著者へ変換しない
    managing_editor: me ? rssPerson(me) : undefined,
    web_master: wm ? rssPerson(wm) : undefined,
    docs: trimmed(kid(c, null, "docs")),
    rating: trimmed(kid(c, null, "rating")),
    text_input: rssTextInput(kid(c, null, "textInput"), null),
    image,
  };
  applyKnownExtensions(ch, c, docUrl, false);
  ch.extensions = children(c)
    .filter((e) => e.namespaceURI !== null || !RSS2_CH_KNOWN.has(e.localName ?? ""))
    .map(toExtension);
  if (!ch.title) issues.push({ level: "warning", code: "rss_channel_title_missing", message: "channel に title がない" });
  if (!link) issues.push({ level: "warning", code: "rss_channel_link_missing", message: "channel に link がない" });
  if (desc === undefined) issues.push({ level: "warning", code: "rss_channel_description_missing", message: "channel に description がない" });

  const items = kids(c, null, "item").map((e, i) => {
    const guidEl = kid(e, null, "guid");
    const guid = guidEl ? { value: (guidEl.textContent ?? "").trim(), is_perma_link: (guidEl.getAttribute("isPermaLink") ?? "true").trim().toLowerCase() !== "false" } : undefined;
    const descRaw = text(kid(e, null, "description"));
    const it = emptyItem({
      format: "rss2",
      guid,
      comments: trimmed(kid(e, null, "comments")),
      description_raw: descRaw,
      description_role: descRaw !== undefined ? "unknown" : undefined,
    });
    it.source_id = guid?.value || undefined;
    const titleEl = kid(e, null, "title");
    if (titleEl) it.title = { type: "text", value: titleEl.textContent ?? "" };
    const l = trimmed(kid(e, null, "link"));
    if (l) it.links.push({ href: resolve(l, docUrl), href_raw: l, rel: "alternate" });
    else if (guid?.is_perma_link && guid.value) it.links.push({ href: resolve(guid.value, docUrl), href_raw: guid.value, rel: "alternate" });
    // description は全文の場合もあるため要約と断定しない。表示用に summary に入れ、役割は unknown として native に記録
    if (descRaw !== undefined) it.summary = { type: "html", value: descRaw };
    const author = trimmed(kid(e, null, "author"));
    if (author) it.authors.push(rssPerson(author));
    it.categories = kids(e, null, "category").map((x) => ({ term: (x.textContent ?? "").trim(), scheme: x.getAttribute("domain") || undefined }));
    for (const enc of kids(e, null, "enclosure")) {
      const url = enc.getAttribute("url") ?? "";
      const len = enc.getAttribute("length");
      it.links.push({
        href: resolve(url, docUrl),
        href_raw: url,
        rel: "enclosure",
        media_type: enc.getAttribute("type") || undefined,
        length_bytes: len && /^\d+$/.test(len) ? Number(len) : undefined,
      });
    }
    const pub = trimmed(kid(e, null, "pubDate"));
    if (pub) it.published_at = parseDate(pub);
    const srcEl = kid(e, null, "source");
    if (srcEl) {
      const s = emptyChannel({ format: "rss2" });
      s.title = { type: "text", value: srcEl.textContent ?? "" };
      const u = srcEl.getAttribute("url");
      if (u) s.links.push({ href: resolve(u, docUrl), href_raw: u, rel: "self" });
      it.source = s;
    }
    applyKnownExtensions(it, e, docUrl, true);
    it.extensions = children(e)
      .filter((x) => x.namespaceURI !== null || !RSS2_ITEM_KNOWN.has(x.localName ?? ""))
      .map(toExtension);
    if (!titleEl && descRaw === undefined) issues.push({ level: "warning", code: "rss_item_title_or_description_missing", message: "item に title も description もない", path: `item[${i}]` });
    return it;
  });
  return { format: "rss2", channel: ch, items, format_validation: issues };
}

const RSS1_KNOWN = new Set(["title", "link", "description", "items", "image", "textinput"]);

function parseRss1(rdf: El, docUrl: string): ParsedFeed {
  const issues: ValidationIssue[] = [];
  const c = kid(rdf, NS.rss1, "channel");
  if (!c) throw new Error("rss1_channel_missing");
  const ch = emptyChannel({ format: "rss1" });
  ch.title = kid(c, NS.rss1, "title") ? { type: "text", value: text(kid(c, NS.rss1, "title"))! } : undefined;
  const d = text(kid(c, NS.rss1, "description"));
  if (d !== undefined) ch.description = { type: "text", value: d };
  const link = trimmed(kid(c, NS.rss1, "link"));
  if (link) ch.links.push({ href: resolve(link, docUrl), href_raw: link, rel: "alternate" });
  const image = rssImage(kid(rdf, NS.rss1, "image"), NS.rss1, docUrl);
  if (image) ch.logo = image;
  ch.native = {
    format: "rss1",
    about: c.getAttributeNS(NS.rdf, "about") || undefined,
    image,
    text_input: rssTextInput(kid(rdf, NS.rss1, "textinput"), NS.rss1),
  };
  applyKnownExtensions(ch, c, docUrl, false);
  ch.extensions = children(c)
    .filter((e) => e.namespaceURI !== NS.rss1 || !RSS1_KNOWN.has(e.localName ?? ""))
    .map(toExtension);
  const items = kids(rdf, NS.rss1, "item").map((e) => {
    const about = e.getAttributeNS(NS.rdf, "about") || undefined;
    const descRaw = text(kid(e, NS.rss1, "description"));
    const it = emptyItem({ format: "rss1", about, description_raw: descRaw, description_role: descRaw !== undefined ? "unknown" : undefined });
    it.source_id = about;
    const t = kid(e, NS.rss1, "title");
    if (t) it.title = { type: "text", value: t.textContent ?? "" };
    const l = trimmed(kid(e, NS.rss1, "link"));
    if (l) it.links.push({ href: resolve(l, docUrl), href_raw: l, rel: "alternate" });
    if (descRaw !== undefined) it.summary = { type: "text", value: descRaw };
    applyKnownExtensions(it, e, docUrl, true);
    it.extensions = children(e)
      .filter((x) => x.namespaceURI !== NS.rss1 || !["title", "link", "description"].includes(x.localName ?? ""))
      .map(toExtension);
    return it;
  });
  if (!ch.title) issues.push({ level: "warning", code: "rss1_channel_title_missing", message: "channel に title がない" });
  return { format: "rss1", channel: ch, items, format_validation: issues };
}

export function parseFeed(xml: string, docUrl: string): ParsedFeed {
  const errors: string[] = [];
  const doc = new DOMParser({
    onError: (level: string, msg: string) => {
      if (level === "fatalError") errors.push(msg);
    },
  }).parseFromString(xml, "application/xml");
  if (errors.length) throw new Error(`xml_parse_error: ${errors[0]}`);
  const root = doc.documentElement as unknown as El | null;
  if (!root) throw new Error("xml_parse_error: no root");
  if (root.localName === "feed" && root.namespaceURI === NS.atom) return parseAtom(root, docUrl);
  if (root.localName === "rss" && !root.namespaceURI) return parseRss2(root, docUrl);
  if (root.localName === "RDF" && root.namespaceURI === NS.rdf) return parseRss1(root, docUrl);
  throw new Error(`unsupported_feed_root: ${root.namespaceURI ?? ""} ${root.localName}`);
}

export function looksLikeFeed(contentType: string | null, body: string): boolean {
  if (contentType && /(rss|atom|rdf)\+xml/i.test(contentType)) return true;
  const head = body.slice(0, 2000);
  return /<(rss|feed|rdf:RDF)[\s>]/i.test(head);
}
