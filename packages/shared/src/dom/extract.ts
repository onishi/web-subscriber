// DOM上で宣言的抽出ルールを評価する（docs/design.md §4.2–4.4）。
// ブラウザ（Chromium）へバンドルして注入し、http/browser 両方式で同一コードを使う。
import type { FieldRule, Selector, SubscriptionConfig, Take } from "../config.js";
import type { ChannelData, Content, DateValue, ItemData, Link, Person, Category, Text } from "../model.js";
import { emptyChannel, emptyItem } from "../model.js";
import { applyTransforms, type Scalar, type TransformEnv } from "../transforms.js";
import { parseDate } from "../date.js";

export type FieldStatus = "ok" | "no_match" | "empty" | "error";

export interface FieldOutcome {
  status: FieldStatus;
  value?: unknown;
  /** text | html：Text型へ変換する際の形式 */
  format?: "text" | "html";
  reason?: string;
  /** 採用したフォールバックの番号（0=主ルール） */
  used?: number;
}

export interface ExtractEnv extends TransformEnv {
  doc: Document;
}

export function selectNodes(root: Node, sel: Selector, env: ExtractEnv): { ok: true; nodes: Node[] } | { ok: false; error: string } {
  try {
    if ("css" in sel) {
      const r = root as Element | Document;
      if (typeof (r as Element).querySelectorAll !== "function") return { ok: false, error: "css_on_non_element" };
      return { ok: true, nodes: Array.from(r.querySelectorAll(sel.css)) };
    }
    const doc = env.doc;
    const res = doc.evaluate(sel.xpath, root, doc.createNSResolver ? doc.createNSResolver(doc.documentElement) : null, 7 /* ORDERED_NODE_SNAPSHOT_TYPE */, null);
    const nodes: Node[] = [];
    for (let i = 0; i < res.snapshotLength; i++) nodes.push(res.snapshotItem(i)!);
    return { ok: true, nodes };
  } catch (e) {
    return { ok: false, error: `selector_error:${(e as Error).message}` };
  }
}

function takeValue(n: Node, take: Take): { value: string | null; format: "text" | "html" } {
  if (typeof take === "object") {
    if (n.nodeType === 1) return { value: (n as Element).getAttribute(take.attr), format: "text" };
    return { value: null, format: "text" };
  }
  if (n.nodeType !== 1) return { value: n.nodeValue ?? n.textContent ?? "", format: "text" };
  const el = n as Element;
  switch (take) {
    case "text":
      return { value: el.textContent ?? "", format: "text" };
    case "inner_html":
      return { value: el.innerHTML, format: "html" };
    case "outer_html":
      return { value: el.outerHTML, format: "html" };
  }
}

function isEmpty(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === "string") return v.trim() === "";
  if (Array.isArray(v)) return v.length === 0 || v.every(isEmpty);
  if (typeof v === "object" && "value" in (v as object) && "raw" in (v as object)) return (v as DateValue).value === null;
  if (typeof v === "object") return Object.values(v as object).every(isEmpty);
  return false;
}

function evalSingle(rule: FieldRule, ctx: Node, env: ExtractEnv): FieldOutcome {
  if ("const" in rule) return { status: "ok", value: rule.const };
  if ("object" in rule) {
    const out: Record<string, unknown> = {};
    for (const [k, sub] of Object.entries(rule.object)) {
      const r = evalRule(sub, ctx, env);
      if (r.status === "error") return { status: "error", reason: `${k}:${r.reason}` };
      if (r.status === "ok") out[k] = r.value;
      else if ((sub as { required?: boolean }).required) return { status: r.status, reason: `${k}:${r.status}` };
    }
    return isEmpty(out) ? { status: "empty" } : { status: "ok", value: out };
  }
  if ("array" in rule) {
    const sel = selectNodes(ctx, rule.array.select, env);
    if (!sel.ok) return { status: "error", reason: sel.error };
    if (sel.nodes.length === 0) return { status: "no_match" };
    const out: unknown[] = [];
    for (const n of sel.nodes) {
      const r = evalRule(rule.array.of, n, env);
      if (r.status === "error") return { status: "error", reason: r.reason };
      if (r.status === "ok") out.push(r.value);
    }
    return out.length ? { status: "ok", value: out } : { status: "empty" };
  }
  // 要素→値
  const card = rule.cardinality ?? "one";
  let nodes: Node[];
  if (rule.from) {
    const sel = selectNodes(ctx, rule.from, env);
    if (!sel.ok) return { status: "error", reason: sel.error };
    nodes = sel.nodes;
  } else nodes = [ctx];
  if (nodes.length === 0) return { status: "no_match" };
  if (card === "one" && nodes.length > 1) return { status: "error", reason: `multiple_matches:${nodes.length}` };
  const take = rule.take ?? "text";
  const picked = card === "many" ? nodes : [nodes[0]];
  const taken = picked.map((n) => takeValue(n, take));
  const format = taken[0]?.format ?? "text";
  let value: Scalar | Scalar[] = card === "many" ? taken.map((t) => t.value) : taken[0].value;
  if (card !== "many" && value === null) return { status: "no_match", reason: "attribute_missing" };
  if (rule.transforms?.length) {
    const r = applyTransforms(value, rule.transforms, env);
    if (!r.ok) return { status: "error", reason: r.error };
    value = r.value;
  }
  if (Array.isArray(value)) value = value.filter((x) => !isEmpty(x));
  if (isEmpty(value)) return { status: "empty" };
  return { status: "ok", value, format };
}

/** フォールバックは no_match / empty のときのみ評価（error は隠さない） */
export function evalRule(rule: FieldRule, ctx: Node, env: ExtractEnv): FieldOutcome {
  const first = evalSingle(rule, ctx, env);
  if (first.status === "ok" || first.status === "error") return { ...first, used: 0 };
  const fb = "fallback" in rule ? rule.fallback : undefined;
  if (fb) {
    for (let i = 0; i < fb.length; i++) {
      const r = evalRule(fb[i], ctx, env);
      if (r.status === "ok" || r.status === "error") return { ...r, used: i + 1 };
    }
  }
  return first;
}

// ---- 共通モデルへの変換 ----

function toText(v: unknown, format: "text" | "html" = "text"): Text | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === "object" && v && "type" in v && "value" in v) return v as Text;
  const s = Array.isArray(v) ? v.join(" ") : String(v);
  return { type: format, value: s };
}

function toDate(v: unknown, env: ExtractEnv): DateValue | undefined {
  if (!v) return undefined;
  if (typeof v === "object" && "raw" in (v as object)) return v as DateValue;
  return parseDate(String(v), { assume_tz: env.timezone });
}

function toLinks(v: unknown, env: ExtractEnv, rel = "alternate"): Link[] {
  const arr = Array.isArray(v) ? v : [v];
  const out: Link[] = [];
  for (const x of arr) {
    if (!x) continue;
    if (typeof x === "string") {
      try {
        out.push({ href: new URL(x, env.baseUrl).toString(), href_raw: x, rel });
      } catch {
        out.push({ href: x, rel });
      }
    } else if (typeof x === "object" && "href" in (x as object)) {
      const o = x as Record<string, unknown>;
      const href = String(o.href);
      let abs = href;
      try {
        abs = new URL(href, env.baseUrl).toString();
      } catch {
        /* keep */
      }
      out.push({
        href: abs,
        href_raw: href !== abs ? href : undefined,
        rel: typeof o.rel === "string" ? o.rel : rel,
        media_type: typeof o.media_type === "string" ? o.media_type : undefined,
        hreflang: typeof o.hreflang === "string" ? o.hreflang : undefined,
        title: typeof o.title === "string" ? o.title : undefined,
        length_bytes: o.length_bytes !== undefined && Number.isFinite(Number(o.length_bytes)) ? Number(o.length_bytes) : undefined,
      });
    }
  }
  return out;
}

function toPersons(v: unknown): Person[] {
  const arr = Array.isArray(v) ? v : [v];
  return arr
    .filter((x) => !isEmpty(x))
    .map((x) => (typeof x === "string" ? { name: x.trim() } : (x as Person)));
}

function toCategories(v: unknown): Category[] {
  const arr = Array.isArray(v) ? v : [v];
  return arr.filter((x) => !isEmpty(x)).map((x) => (typeof x === "string" ? { term: x.trim() } : (x as Category)));
}

function toContent(v: unknown, format: "text" | "html"): Content | undefined {
  if (isEmpty(v)) return undefined;
  if (typeof v === "object" && v && "kind" in v) return v as Content;
  return { kind: "inline", type: format, value: Array.isArray(v) ? v.join("\n") : String(v) };
}

type Target = { kind: "item"; data: ItemData } | { kind: "channel"; data: ChannelData };

function assign(target: Target, name: string, o: FieldOutcome, env: ExtractEnv, extracted: Record<string, unknown>) {
  const v = o.value;
  const d = target.data as ItemData & ChannelData;
  switch (name) {
    case "source_id":
      d.source_id = String(v).trim();
      return;
    case "title":
      d.title = toText(v, o.format);
      return;
    case "description":
      if (target.kind === "channel") {
        d.description = toText(v, o.format);
        return;
      }
      break;
    case "summary":
      if (target.kind === "item") {
        d.summary = toText(v, o.format);
        return;
      }
      break;
    case "content":
      if (target.kind === "item") {
        d.content = toContent(v, o.format ?? "text");
        return;
      }
      break;
    case "link":
    case "links":
      d.links.push(...toLinks(v, env));
      return;
    case "enclosures":
      d.links.push(...toLinks(v, env, "enclosure"));
      return;
    case "author":
    case "authors":
      d.authors.push(...toPersons(v));
      return;
    case "contributors":
      d.contributors.push(...toPersons(v));
      return;
    case "categories":
    case "category":
      d.categories.push(...toCategories(v));
      return;
    case "rights":
      d.rights = toText(v, o.format);
      return;
    case "language":
      d.language = String(v);
      return;
    case "published_at":
      d.published_at = toDate(v, env);
      return;
    case "updated_at":
      d.updated_at = toDate(v, env);
      return;
    case "icon":
    case "logo":
      if (target.kind === "channel") {
        const url = toLinks(v, env)[0]?.href;
        if (url) d[name] = { url };
        return;
      }
      break;
  }
  extracted[name] = v;
}

export interface FieldFailureStats {
  [field: string]: { no_match: number; empty: number; error: number; reasons: string[] };
}

export interface ExtractedItem {
  data: ItemData;
  valid: boolean;
  failures: { field: string; status: FieldStatus; reason?: string }[];
}

export interface PageExtraction {
  status: "success" | "failed";
  reason?: string;
  container_found: boolean;
  empty_marker_found: boolean;
  item_nodes: number;
  items: ExtractedItem[];
  invalid_items: number;
  field_failures: FieldFailureStats;
  channel?: ChannelData;
  channel_failures: { field: string; status: FieldStatus; reason?: string }[];
}

function record(stats: FieldFailureStats, field: string, o: FieldOutcome) {
  if (o.status === "ok") return;
  const s = (stats[field] ??= { no_match: 0, empty: 0, error: 0, reasons: [] });
  s[o.status]++;
  if (o.reason && s.reasons.length < 5 && !s.reasons.includes(o.reason)) s.reasons.push(o.reason);
}

export function extractItemFrom(node: Node, fields: Record<string, FieldRule>, env: ExtractEnv, stats: FieldFailureStats): ExtractedItem {
  const data = emptyItem({ format: "html", extracted_fields: {} });
  const extracted: Record<string, unknown> = {};
  const failures: ExtractedItem["failures"] = [];
  let valid = true;
  for (const [name, rule] of Object.entries(fields)) {
    const o = evalRule(rule, node, env);
    record(stats, name, o);
    if (o.status === "ok") assign({ kind: "item", data }, name, o, env, extracted);
    else {
      failures.push({ field: name, status: o.status, reason: o.reason });
      if ((rule as { required?: boolean }).required || o.status === "error") valid = false;
    }
  }
  data.native = { format: "html", extracted_fields: extracted };
  return { data, valid, failures };
}

export function extractPage(config: SubscriptionConfig, env: ExtractEnv): PageExtraction {
  const ex = config.extract!;
  const stats: FieldFailureStats = {};
  const res: PageExtraction = {
    status: "success",
    container_found: false,
    empty_marker_found: false,
    item_nodes: 0,
    items: [],
    invalid_items: 0,
    field_failures: stats,
    channel_failures: [],
  };

  // channel：最初の文書全体が起点
  const ch = emptyChannel({ format: "html", document_url: env.baseUrl, extracted_fields: {} });
  const chExtracted: Record<string, unknown> = {};
  for (const [name, rule] of Object.entries(ex.channel.fields)) {
    const o = evalRule(rule, env.doc, env);
    if (o.status === "ok") assign({ kind: "channel", data: ch }, name, o, env, chExtracted);
    else res.channel_failures.push({ field: name, status: o.status, reason: o.reason });
  }
  if (!ch.title) {
    const t = env.doc.querySelector("title")?.textContent?.trim();
    if (t && !("title" in ex.channel.fields)) ch.title = { type: "text", value: t };
  }
  if (!ch.links.length) ch.links.push({ href: env.baseUrl, rel: "alternate" });
  ch.native = { format: "html", document_url: env.baseUrl, extracted_fields: chExtracted };
  res.channel = ch;

  const container = selectNodes(env.doc, ex.items.container, env);
  if (!container.ok) return { ...res, status: "failed", reason: container.error };
  res.container_found = container.nodes.length > 0;
  if (ex.items.empty_marker) {
    const em = selectNodes(env.doc, ex.items.empty_marker, env);
    if (!em.ok) return { ...res, status: "failed", reason: em.error };
    res.empty_marker_found = em.nodes.length > 0;
  }
  const sel = selectNodes(env.doc, ex.items.select, env);
  if (!sel.ok) return { ...res, status: "failed", reason: sel.error };
  res.item_nodes = sel.nodes.length;

  if (sel.nodes.length === 0) {
    // 正常な0件と構造変更による失敗の区別
    if (res.empty_marker_found) return res;
    switch (ex.items.zero_items_policy) {
      case "ok_if_container":
        return res.container_found ? res : { ...res, status: "failed", reason: "container_not_found" };
      case "require_empty_marker":
        return { ...res, status: "failed", reason: res.container_found ? "zero_items_without_empty_marker" : "container_not_found" };
      case "fail":
        return { ...res, status: "failed", reason: "zero_items" };
    }
  }
  if (!res.container_found) {
    // item はあるが container がない＝構造が想定と違う
    return { ...res, status: "failed", reason: "container_not_found" };
  }
  for (const n of sel.nodes) {
    const it = extractItemFrom(n, ex.items.fields, env, stats);
    res.items.push(it);
    if (!it.valid) res.invalid_items++;
  }
  if (res.items.length && res.invalid_items / res.items.length > ex.items.invalid_item_threshold) {
    return { ...res, status: "failed", reason: `invalid_items_over_threshold:${res.invalid_items}/${res.items.length}` };
  }
  return res;
}
