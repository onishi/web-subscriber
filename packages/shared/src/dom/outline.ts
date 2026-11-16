// AI調査用：DOMを圧縮したアウトラインと、繰り返し構造・ページング候補を作る（ブラウザ内実行）

function cssEscape(s: string): string {
  return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/[^a-zA-Z0-9_-]/g, (c) => "\\" + c);
}

const isStableClass = (c: string) => c.length < 40 && !/\d{4,}|^css-|^sc-|^jsx-|__[a-z0-9]{5,}$/i.test(c);

export function cssPath(el: Element, stopAt?: Element): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== stopAt && cur.nodeType === 1 && cur.tagName !== "HTML") {
    let p = cur.tagName.toLowerCase();
    if (cur.id && !/\d{3,}/.test(cur.id)) {
      parts.unshift(`${p}#${cssEscape(cur.id)}`);
      break;
    }
    const cls = Array.from(cur.classList).filter(isStableClass).slice(0, 2);
    if (cls.length) p += "." + cls.map(cssEscape).join(".");
    parts.unshift(p);
    cur = cur.parentElement;
  }
  return parts.join(" > ");
}

function sig(el: Element): string {
  return el.tagName.toLowerCase() + "." + Array.from(el.classList).filter(isStableClass).sort().join(".");
}

function snippet(s: string | null | undefined, n = 80): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
}

export interface RepeatCandidate {
  container: string;
  item_selector: string;
  count: number;
  sample_html: string[];
  sample_text: string[];
  links_per_item: number;
}

export interface PagingCandidate {
  selector: string;
  tag: string;
  text: string;
  href?: string | null;
  rel?: string | null;
  disabled: boolean;
  matches: number;
}

export interface Outline {
  url: string;
  title: string;
  text_length: number;
  link_count: number;
  outline: string;
  repeats: RepeatCandidate[];
  paging: PagingCandidate[];
  feed_links: { href: string; type: string; title: string | null }[];
  jsonld_types: string[];
}

export function buildOutline(maxChars = 24000): Outline {
  const lines: string[] = [];
  let size = 0;
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "PATH", "IFRAME", "TEMPLATE", "LINK", "META"]);
  const walk = (el: Element, depth: number) => {
    if (size > maxChars || depth > 14 || SKIP.has(el.tagName)) return;
    const kids = Array.from(el.children).filter((c) => !SKIP.has(c.tagName));
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => n.textContent)
      .join(" ");
    let label = el.tagName.toLowerCase();
    if (el.id) label += "#" + el.id;
    const cls = Array.from(el.classList).slice(0, 3);
    if (cls.length) label += "." + cls.join(".");
    for (const a of ["href", "datetime", "rel", "aria-label", "role", "type"]) {
      const v = el.getAttribute(a);
      if (v) label += ` ${a}="${snippet(v, 60)}"`;
    }
    const t = snippet(own, 60);
    const line = "  ".repeat(depth) + label + (t ? ` "${t}"` : "") + (kids.length > 8 ? ` [${kids.length} children]` : "");
    lines.push(line);
    size += line.length + 1;
    // 同じ形の兄弟が続く場合は先頭2つだけ展開
    const seen = new Map<string, number>();
    for (const k of kids) {
      const s = sig(k);
      const n = (seen.get(s) ?? 0) + 1;
      seen.set(s, n);
      if (n <= 2) walk(k, depth + 1);
      else if (n === 3) {
        const total = kids.filter((x) => sig(x) === s).length;
        const l = "  ".repeat(depth + 1) + `… (${total - 2} more ${s})`;
        lines.push(l);
        size += l.length;
      }
    }
  };
  if (document.body) walk(document.body, 0);

  // 繰り返し構造候補
  const groups = new Map<Element, Map<string, Element[]>>();
  document.querySelectorAll("body *").forEach((el) => {
    const p = el.parentElement;
    if (!p || SKIP.has(el.tagName)) return;
    let m = groups.get(p);
    if (!m) groups.set(p, (m = new Map()));
    const s = sig(el);
    const arr = m.get(s) ?? [];
    arr.push(el);
    m.set(s, arr);
  });
  const repeats: RepeatCandidate[] = [];
  groups.forEach((m, parent) => {
    m.forEach((els) => {
      if (els.length < 3) return;
      const withText = els.filter((e) => (e.textContent ?? "").trim().length > 10);
      if (withText.length < 3) return;
      const linksPer = els.reduce((a, e) => a + e.querySelectorAll("a[href]").length, 0) / els.length;
      const container = cssPath(parent);
      const first = els[0];
      let item = first.tagName.toLowerCase();
      const cls = Array.from(first.classList).filter(isStableClass).slice(0, 2);
      if (cls.length) item += "." + cls.map(cssEscape).join(".");
      repeats.push({
        container,
        item_selector: `${container} > ${item}`,
        count: els.length,
        sample_html: els.slice(0, 2).map((e) => e.outerHTML.slice(0, 1500)),
        sample_text: els.slice(0, 3).map((e) => snippet(e.textContent, 120)),
        links_per_item: Math.round(linksPer * 10) / 10,
      });
    });
  });
  repeats.sort((a, b) => b.count * (b.links_per_item > 0 ? 2 : 1) * Math.min(b.sample_text.join("").length, 300) - a.count * (a.links_per_item > 0 ? 2 : 1) * Math.min(a.sample_text.join("").length, 300));

  const pagingRe = /次|もっと|さらに|続き|next|more|older|load|›|»|→|>/i;
  const paging: PagingCandidate[] = [];
  document.querySelectorAll("a, button, [role=button], link[rel=next]").forEach((el) => {
    const text = snippet(el.textContent || el.getAttribute("aria-label") || el.getAttribute("title"), 40);
    const rel = el.getAttribute("rel");
    if (!(rel && /next/i.test(rel)) && !(text && text.length <= 20 && pagingRe.test(text))) return;
    const selector = cssPath(el);
    paging.push({
      selector,
      tag: el.tagName.toLowerCase(),
      text,
      href: el.getAttribute("href"),
      rel,
      disabled: el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true",
      matches: (() => {
        try {
          return document.querySelectorAll(selector).length;
        } catch {
          return -1;
        }
      })(),
    });
  });

  const feed_links = Array.from(document.querySelectorAll('link[rel~="alternate"]'))
    .filter((l) => /(rss|atom|rdf)\+xml|application\/feed\+json/i.test(l.getAttribute("type") ?? ""))
    .map((l) => ({ href: (l as HTMLLinkElement).href, type: l.getAttribute("type") ?? "", title: l.getAttribute("title") }));

  const jsonld_types: string[] = [];
  document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
    try {
      const j = JSON.parse(s.textContent ?? "");
      const arr = Array.isArray(j) ? j : j["@graph"] ?? [j];
      for (const x of arr) if (x && x["@type"]) jsonld_types.push(String(x["@type"]));
    } catch {
      /* ignore */
    }
  });

  return {
    url: location.href,
    title: document.title,
    text_length: (document.body?.textContent ?? "").replace(/\s+/g, " ").length,
    link_count: document.querySelectorAll("a[href]").length,
    outline: lines.join("\n"),
    repeats: repeats.slice(0, 8),
    paging: paging.slice(0, 15),
    feed_links,
    jsonld_types,
  };
}

export function inspectSelector(sel: { css: string } | { xpath: string }) {
  let nodes: Node[] = [];
  try {
    if ("css" in sel) nodes = Array.from(document.querySelectorAll(sel.css));
    else {
      const r = document.evaluate(sel.xpath, document, null, 7, null);
      for (let i = 0; i < r.snapshotLength; i++) nodes.push(r.snapshotItem(i)!);
    }
  } catch (e) {
    return { error: String((e as Error).message), count: 0, samples: [] };
  }
  return {
    count: nodes.length,
    samples: nodes.slice(0, 5).map((n) => (n.nodeType === 1 ? (n as Element).outerHTML.slice(0, 2000) : String(n.textContent).slice(0, 500))),
  };
}
