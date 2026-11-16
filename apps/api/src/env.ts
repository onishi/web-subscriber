import { ulid } from "ulid";
import { tzOffsetMinutes } from "@ws/shared";

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  ASSETS: Fetcher;
  SETUP_WORKFLOW: Workflow;
  DEFAULT_TIMEZONE: string;
  GEMINI_MODEL: string;
  REPAIR_AFTER_FAILURES: string;
  ACCESS_TEAM_DOMAIN: string;
  ACCESS_AUD: string;
  DEV_AUTH_BYPASS: string;
  GEMINI_API_KEY?: string;
  /** テスト用：Gemini API の代わりにモックへ向ける */
  GEMINI_BASE_URL?: string;
}

export const newId = () => ulid();
export const nowIso = () => new Date().toISOString();

export function addMinutes(iso: string, min: number): string {
  return new Date(Date.parse(iso) + min * 60000).toISOString();
}

/** 購読IDから1日の中の実行時刻（分）を決める。時刻を絞らず1日に分散する。 */
export async function scheduleMinute(id: string): Promise<number> {
  const h = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id)));
  return ((h[0] << 8) | h[1]) % 1440;
}

/** 現在時刻より後で、timezone の壁時計で minuteOfDay になる最初の時刻（interval が1日未満なら間隔で刻む） */
export function nextRunAt(minuteOfDay: number, intervalMinutes: number, tz: string, after: Date = new Date()): string {
  if (intervalMinutes < 1440) {
    // 基準時刻（minuteOfDay）から interval ごとのスロット
    const step = intervalMinutes * 60000;
    const anchor = Date.parse(nextRunAt(minuteOfDay, 1440, tz, new Date(after.getTime() - 86400000)));
    const n = Math.floor((after.getTime() - anchor) / step) + 1;
    return new Date(anchor + n * step).toISOString();
  }
  for (let dayOffset = -1; dayOffset <= 2; dayOffset++) {
    const d = new Date(after.getTime() + dayOffset * 86400000);
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d);
    const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
    const y = g("year"),
      m = g("month"),
      day = g("day");
    const h = Math.floor(minuteOfDay / 60),
      mi = minuteOfDay % 60;
    const off = tzOffsetMinutes(tz, y, m, day, h, mi, 0);
    const t = Date.UTC(y, m - 1, day, h, mi, 0) - off * 60000;
    if (t > after.getTime()) return new Date(t).toISOString();
  }
  return new Date(after.getTime() + 86400000).toISOString();
}

export async function sha256(s: string): Promise<string> {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function randomToken(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function json<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}
