// 識別キーと変更検知ハッシュ（docs/design.md §5）
import type { ItemData, ChannelData } from "./model.js";
import { primaryLink } from "./model.js";
import type { SubscriptionConfig } from "./config.js";

/** キー順を固定し、undefined/空配列/空文字を除外した正規形JSON */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(normalize(v)) ?? "null";
}

function normalize(v: unknown): unknown {
  if (v === null || v === undefined) return undefined;
  if (Array.isArray(v)) {
    const arr = v.map(normalize).filter((x) => x !== undefined);
    return arr.length ? arr : undefined;
  }
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const n = normalize((v as Record<string, unknown>)[k]);
      if (n !== undefined) out[k] = n;
    }
    return Object.keys(out).length ? out : undefined;
  }
  if (typeof v === "string") return v === "" ? undefined : v;
  return v;
}

export async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function itemField(item: ItemData, name: string): unknown {
  if (name === "link") return primaryLink(item);
  if (name in item && name !== "native" && name !== "extensions") return (item as unknown as Record<string, unknown>)[name];
  if (item.native.format === "html") return item.native.extracted_fields[name];
  if (name === "guid" && (item.native.format === "rss2" || item.native.format === "rss1")) return item.native.guid?.value;
  return undefined;
}

/** フィールド値を比較用の文字列へ（Text/DateValue は値部分） */
function fieldToKeyString(v: unknown): string {
  if (v === undefined || v === null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "object" && "value" in (v as object) && typeof (v as { value: unknown }).value === "string")
    return ((v as { value: string }).value ?? "").trim();
  if (typeof v === "object" && "raw" in (v as object)) return String((v as { value: unknown; raw: string }).value ?? (v as { raw: string }).raw);
  return canonicalJson(v);
}

export function normalizeLinkForIdentity(href: string, ops: string[]): string {
  try {
    const u = new URL(href);
    if (ops.includes("strip_fragment")) u.hash = "";
    if (ops.includes("strip_query")) u.search = "";
    return u.toString();
  } catch {
    return href;
  }
}

export type IdentityResult = { ok: true; key: string } | { ok: false; reason: string };

export async function identityKey(item: ItemData, cfg: SubscriptionConfig["identity"]): Promise<IdentityResult> {
  switch (cfg.method) {
    case "source_id": {
      // Atom id 等は URL に見えても厳密な文字列比較。正規化しない。
      const v = item.source_id;
      return v ? { ok: true, key: v } : { ok: false, reason: "source_id_missing" };
    }
    case "link": {
      const l = primaryLink(item);
      return l ? { ok: true, key: normalizeLinkForIdentity(l, cfg.link_normalization) } : { ok: false, reason: "link_missing" };
    }
    case "fields":
    case "content_hash": {
      const parts = cfg.fields.map((f) => fieldToKeyString(itemField(item, f)));
      if (parts.every((p) => p === "")) return { ok: false, reason: "identity_fields_empty" };
      const h = await sha256Hex(cfg.method === "fields" ? parts.join("\u001f") : canonicalJson(cfg.fields.map((f) => itemField(item, f))));
      return { ok: true, key: `${cfg.method}:${h}` };
    }
  }
}

export async function itemContentHash(item: ItemData, fields: readonly string[]): Promise<string> {
  const obj: Record<string, unknown> = {};
  for (const f of [...fields].sort()) obj[f] = itemField(item, f);
  if (item.native.format === "html") obj["__extracted"] = item.native.extracted_fields;
  return sha256Hex(canonicalJson(obj));
}

/** 画像（icon/logo）は変更検知の対象外 */
export async function channelContentHash(ch: ChannelData): Promise<string> {
  const { native, icon: _icon, logo: _logo, ...rest } = ch;
  const nativeForHash = native.format === "html" ? { ...native, document_url: undefined } : native;
  return sha256Hex(canonicalJson({ ...rest, native: nativeForHash }));
}

export async function schemeHash(v: unknown): Promise<string> {
  return (await sha256Hex(canonicalJson(v))).slice(0, 16);
}
