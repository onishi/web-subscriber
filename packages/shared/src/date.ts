// 日付解析。日付のみの情報には時刻を付けない。補完したタイムゾーンは明示する。
import type { DateValue } from "./model.js";

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const TZ_ABBR: Record<string, number> = { UT: 0, UTC: 0, GMT: 0, Z: 0, EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420, JST: 540 };

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

function fmtOffset(min: number): string {
  if (min === 0) return "Z";
  const s = min < 0 ? "-" : "+";
  const a = Math.abs(min);
  return `${s}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

/** IANA TZ のある壁時計時刻に対するUTCオフセット（分） */
export function tzOffsetMinutes(tz: string, y: number, mo: number, d: number, h: number, mi: number, s: number): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  const calc = (t: number) => {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    }).formatToParts(new Date(t));
    const g = (type: string) => Number(parts.find((p) => p.type === type)?.value);
    return (Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - t) / 60000;
  };
  const off1 = calc(guess);
  const off2 = calc(guess - off1 * 60000);
  return off2;
}

function validYMD(y: number, m: number, d: number) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

interface Parts {
  y: number;
  mo?: number;
  d?: number;
  h?: number;
  mi?: number;
  s?: number;
  frac?: string;
  offset?: number; // 分
}

function build(raw: string, p: Parts, assumeTz?: string): DateValue {
  if (p.mo === undefined) return { raw, value: pad(p.y, 4), precision: "year", tz: "none" };
  if (p.d === undefined) return { raw, value: `${pad(p.y, 4)}-${pad(p.mo)}`, precision: "month", tz: "none" };
  if (!validYMD(p.y, p.mo, p.d)) return { raw, value: null, precision: "unknown", tz: "none", parse_error: "invalid_date" };
  const date = `${pad(p.y, 4)}-${pad(p.mo)}-${pad(p.d)}`;
  if (p.h === undefined) return { raw, value: date, precision: "date", tz: "none" };
  if (p.h > 24 || (p.mi ?? 0) > 59 || (p.s ?? 0) > 60) return { raw, value: null, precision: "unknown", tz: "none", parse_error: "invalid_time" };
  const time = `${pad(p.h)}:${pad(p.mi ?? 0)}:${pad(p.s ?? 0)}${p.frac ? "." + p.frac : ""}`;
  if (p.offset !== undefined) return { raw, value: `${date}T${time}${fmtOffset(p.offset)}`, precision: "datetime", tz: "explicit" };
  if (assumeTz) {
    try {
      const off = tzOffsetMinutes(assumeTz, p.y, p.mo, p.d, p.h, p.mi ?? 0, p.s ?? 0);
      return { raw, value: `${date}T${time}${fmtOffset(off)}`, precision: "datetime", tz: "assumed", assumed_tz: assumeTz };
    } catch {
      return { raw, value: null, precision: "unknown", tz: "none", parse_error: "unknown_timezone" };
    }
  }
  // タイムゾーン不明・補完なし：ローカル時刻のまま保持
  return { raw, value: `${date}T${time}`, precision: "datetime", tz: "none" };
}

function parseOffset(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const up = s.toUpperCase();
  if (up in TZ_ABBR) return TZ_ABBR[up];
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(s);
  if (m) return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  return undefined;
}

const RE_ISO = /^(\d{4})(?:-(\d{2})(?:-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|[+-]\d{2}:?\d{2})?)?)?)?$/i;
const RE_822 = /^(?:[A-Za-z]{3},?\s+)?(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{2,4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*([A-Za-z]{1,5}|[+-]\d{4})?$/;
const RE_JA = /^(\d{4})\s*[年./-]\s*(\d{1,2})\s*[月./-]\s*(\d{1,2})\s*日?(?:\s*[(（][^)）]*[)）])?(?:\s*(\d{1,2})\s*[:時]\s*(\d{1,2})\s*分?(?:\s*[:]?\s*(\d{1,2})\s*秒?)?)?$/;

function compileFormat(fmt: string): { re: RegExp; keys: string[] } {
  const keys: string[] = [];
  let src = "";
  const tokens = /(yyyy|MM|M|dd|d|HH|H|mm|ss|MMM|Z)/g;
  let last = 0;
  for (const m of fmt.matchAll(tokens)) {
    src += fmt.slice(last, m.index).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const t = m[0];
    keys.push(t);
    src +=
      t === "yyyy" ? "(\\d{4})" : t === "MMM" ? "([A-Za-z]{3})" : t === "Z" ? "(Z|[+-]\\d{2}:?\\d{2})" : t.length === 2 ? "(\\d{2})" : "(\\d{1,2})";
    last = (m.index ?? 0) + t.length;
  }
  src += fmt.slice(last).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return { re: new RegExp("^" + src + "$"), keys };
}

export interface ParseDateOptions {
  formats?: string[];
  assume_tz?: string;
}

export function parseDate(input: string, opts: ParseDateOptions = {}): DateValue {
  const raw = input;
  const s = input.trim().replace(/\s+/g, " ");
  if (!s) return { raw, value: null, precision: "unknown", tz: "none", parse_error: "empty" };

  for (const f of opts.formats ?? []) {
    const { re, keys } = compileFormat(f);
    const m = re.exec(s);
    if (!m) continue;
    const p: Parts = { y: 0 };
    keys.forEach((k, i) => {
      const v = m[i + 1];
      if (k === "yyyy") p.y = Number(v);
      else if (k === "MM" || k === "M") p.mo = Number(v);
      else if (k === "MMM") p.mo = MONTHS[v.toLowerCase()];
      else if (k === "dd" || k === "d") p.d = Number(v);
      else if (k === "HH" || k === "H") p.h = Number(v);
      else if (k === "mm") p.mi = Number(v);
      else if (k === "ss") p.s = Number(v);
      else if (k === "Z") p.offset = parseOffset(v);
    });
    return build(raw, p, opts.assume_tz);
  }

  let m = RE_ISO.exec(s);
  if (m) {
    return build(
      raw,
      {
        y: Number(m[1]),
        mo: m[2] ? Number(m[2]) : undefined,
        d: m[3] ? Number(m[3]) : undefined,
        h: m[4] ? Number(m[4]) : undefined,
        mi: m[5] ? Number(m[5]) : undefined,
        s: m[6] ? Number(m[6]) : undefined,
        frac: m[7],
        offset: parseOffset(m[8]),
      },
      opts.assume_tz,
    );
  }
  m = RE_822.exec(s);
  if (m) {
    const mo = MONTHS[m[2].toLowerCase()];
    if (!mo) return { raw, value: null, precision: "unknown", tz: "none", parse_error: "unknown_month" };
    let y = Number(m[3]);
    if (m[3].length === 2) y += y < 50 ? 2000 : 1900;
    const off = m[7] ? parseOffset(m[7]) : undefined;
    if (m[7] && off === undefined) {
      // 未知のタイムゾーン略号：時刻は保持し、TZ不明とする
      return { ...build(raw, { y, mo, d: Number(m[1]), h: m[4] ? Number(m[4]) : undefined, mi: m[5] ? Number(m[5]) : undefined, s: m[6] ? Number(m[6]) : undefined }), parse_error: "unknown_tz_abbr" };
    }
    return build(raw, { y, mo, d: Number(m[1]), h: m[4] ? Number(m[4]) : undefined, mi: m[5] ? Number(m[5]) : undefined, s: m[6] ? Number(m[6]) : undefined, offset: off }, opts.assume_tz);
  }
  m = RE_JA.exec(s);
  if (m) {
    return build(
      raw,
      { y: Number(m[1]), mo: Number(m[2]), d: Number(m[3]), h: m[4] ? Number(m[4]) : undefined, mi: m[5] ? Number(m[5]) : undefined, s: m[6] ? Number(m[6]) : undefined },
      opts.assume_tz,
    );
  }
  return { raw, value: null, precision: "unknown", tz: "none", parse_error: "unrecognized_format" };
}

/** 並び替え用キー。日付のみなら日付のみ（時刻を捏造しない）。datetime は UTC に変換 */
export function sortKey(d: DateValue | undefined): string | null {
  if (!d || !d.value) return null;
  if (d.precision === "datetime" && d.tz !== "none") {
    const t = Date.parse(d.value);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return d.value;
}
