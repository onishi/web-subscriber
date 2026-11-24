// API クライアントと表示用ユーティリティ
export async function api<T = any>(path: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(`/api/v1${path}`, {
    ...init,
    headers: { ...(init?.json !== undefined ? { "Content-Type": "application/json" } : {}), ...init?.headers },
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw Object.assign(new Error(data?.error ?? `HTTP ${res.status}`), { status: res.status, data });
  return data as T;
}

const TZ = "Asia/Tokyo";

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("ja-JP", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

export function fmtRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  const diff = (Date.parse(iso) - Date.now()) / 60000;
  const a = Math.abs(diff);
  const s = a < 1 ? "1分未満" : a < 60 ? `${Math.round(a)}分` : a < 1440 ? `${Math.round(a / 60)}時間` : `${Math.round(a / 1440)}日`;
  return diff >= 0 ? `${s}後` : `${s}前`;
}

export interface DateValue {
  raw: string;
  value: string | null;
  precision: string;
  tz: string;
  assumed_tz?: string;
}

/** 日付のみの情報は日付のみ表示（時刻を捏造しない） */
export function fmtDateValue(d: DateValue | null | undefined): string {
  if (!d) return "";
  if (!d.value) return d.raw;
  if (d.precision === "datetime") {
    if (d.tz === "none") return d.value.replace("T", " ").slice(0, 16) + "（TZ不明）";
    return fmtTime(d.value);
  }
  return d.value;
}

export const HEALTH_LABEL: Record<string, string> = {
  ok: "正常",
  fetch_error: "取得異常",
  extract_error: "抽出異常",
  degraded: "要確認",
  unknown: "未確認",
};

export const CHANGE_LABEL: Record<string, string> = {
  initial: "初回（基準）",
  changed: "変更あり",
  unchanged: "変更なし",
  unknown: "判定不能",
};

export const RUN_LABEL: Record<string, string> = {
  queued: "待機",
  running: "実行中",
  completed: "完了",
  partial: "一部取得",
  failed: "失敗",
};

export const END_LABEL: Record<string, string> = {
  single_page: "1ページ",
  no_next: "次へなし",
  next_disabled: "次へ無効",
  cycle_detected: "循環検知",
  max_pages: "上限（ページ）",
  max_items: "上限（件数）",
  max_actions: "上限（操作）",
  max_duration: "上限（時間）",
  wait_timeout: "待機タイムアウト",
  error: "エラー",
  config_error: "設定エラー",
  robots_disallowed: "robots.txt拒否",
  lease_expired: "クローラ応答なし",
};

export const TRIGGER_LABEL: Record<string, string> = { scheduled: "定期", manual: "手動", retry: "再試行", activation: "設定適用" };
