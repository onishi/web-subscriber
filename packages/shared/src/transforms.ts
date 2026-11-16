// 変換処理（許可リスト・純関数）。ブラウザ内でもNodeでも動く。
import type { Transform } from "./config.js";
import type { DateValue } from "./model.js";
import { parseDate } from "./date.js";

export type Scalar = string | number | DateValue | null;
export type TransformResult = { ok: true; value: Scalar | Scalar[] } | { ok: false; error: string };

export interface TransformEnv {
  baseUrl: string;
  timezone: string;
}

function decodeEntities(s: string): string {
  const map: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) ? String.fromCodePoint(cp) : m;
    }
    return map[e.toLowerCase()] ?? m;
  });
}

function one(v: Scalar, t: Transform, env: TransformEnv): TransformResult {
  if (v === null) return { ok: true, value: null };
  if (typeof t === "object" && "default" in t) return { ok: true, value: v };
  if (typeof v !== "string") {
    if (typeof t === "string" && (t === "trim" || t === "collapse_whitespace")) return { ok: true, value: v };
    return { ok: false, error: `transform_requires_string:${typeof t === "string" ? t : Object.keys(t)[0]}` };
  }
  if (typeof t === "string") {
    switch (t) {
      case "trim":
        return { ok: true, value: v.trim() };
      case "collapse_whitespace":
        return { ok: true, value: v.replace(/\s+/g, " ").trim() };
      case "lowercase":
        return { ok: true, value: v.toLowerCase() };
      case "uppercase":
        return { ok: true, value: v.toUpperCase() };
      case "strip_tags":
        return { ok: true, value: v.replace(/<[^>]*>/g, "") };
      case "decode_entities":
        return { ok: true, value: decodeEntities(v) };
      case "parse_int": {
        const n = parseInt(v.replace(/[,\s]/g, ""), 10);
        return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: "parse_int_failed" };
      }
      case "parse_number": {
        const n = Number(v.replace(/[,\s]/g, ""));
        return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, error: "parse_number_failed" };
      }
    }
  }
  if ("resolve_url" in t) {
    if (v.trim() === "") return { ok: true, value: "" };
    try {
      return { ok: true, value: new URL(v.trim(), t.resolve_url.base ? new URL(t.resolve_url.base, env.baseUrl).toString() : env.baseUrl).toString() };
    } catch {
      return { ok: false, error: "resolve_url_failed" };
    }
  }
  if ("parse_date" in t) {
    const d = parseDate(v, { formats: t.parse_date.formats, assume_tz: t.parse_date.assume_tz ?? env.timezone });
    if (d.value === null) return { ok: false, error: `parse_date_failed:${d.parse_error}` };
    return { ok: true, value: d };
  }
  if ("regex_extract" in t) {
    let re: RegExp;
    try {
      re = new RegExp(t.regex_extract.pattern, t.regex_extract.flags);
    } catch {
      return { ok: false, error: "invalid_regex" };
    }
    const m = re.exec(v);
    return { ok: true, value: m ? (m[t.regex_extract.group] ?? "") : "" };
  }
  if ("regex_replace" in t) {
    try {
      return { ok: true, value: v.replace(new RegExp(t.regex_replace.pattern, t.regex_replace.flags), t.regex_replace.replacement) };
    } catch {
      return { ok: false, error: "invalid_regex" };
    }
  }
  if ("split" in t) return { ok: true, value: v.split(t.split.sep) };
  if ("nullify_if" in t) return { ok: true, value: t.nullify_if.equals.includes(v) ? null : v };
  if ("prefix" in t) return { ok: true, value: t.prefix.value + v };
  if ("suffix" in t) return { ok: true, value: v + t.suffix.value };
  return { ok: false, error: "unknown_transform" };
}

export function applyTransforms(value: Scalar | Scalar[], transforms: Transform[], env: TransformEnv): TransformResult {
  let cur: Scalar | Scalar[] = value;
  for (const t of transforms) {
    if (typeof t === "object" && "join" in t) {
      cur = Array.isArray(cur) ? cur.map((x) => (x === null ? "" : String(typeof x === "object" ? x.value : x))).join(t.join.sep) : cur;
      continue;
    }
    if (typeof t === "object" && "default" in t) {
      const empty = cur === null || cur === "" || (Array.isArray(cur) && cur.length === 0);
      if (empty) cur = t.default.value;
      continue;
    }
    if (Array.isArray(cur)) {
      const out: Scalar[] = [];
      for (const x of cur) {
        const r = one(x, t, env);
        if (!r.ok) return r;
        if (Array.isArray(r.value)) out.push(...r.value);
        else out.push(r.value);
      }
      cur = out;
    } else {
      const r = one(cur, t, env);
      if (!r.ok) return r;
      cur = r.value;
    }
  }
  return { ok: true, value: cur };
}
