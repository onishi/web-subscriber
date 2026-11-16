// クローラ(VPS) ⇔ API(Cloudflare) のプロトコル（docs/design.md §6）
import type { ChannelData, ItemData } from "./model.js";
import type { SubscriptionConfig } from "./config.js";

export interface FieldFailureStats {
  [field: string]: { no_match: number; empty: number; error: number; reasons: string[] };
}

export const CRAWLER_VERSION = "0.0.1";
export const USER_AGENT_PRODUCT = "Web-Subscriber";

export type JobKind = "crawl" | "probe";
export type RunTrigger = "scheduled" | "manual" | "retry" | "activation";

export type ProbeKind = "discover" | "extract" | "inspect" | "feed" | "outline" | "detail";

export interface LeasedJob {
  job_id: string;
  kind: JobKind;
  lease_token: string;
  lease_expires_at: string;
  attempt: number;
  /** crawl のとき */
  run_id?: string;
  subscription_id?: string;
  config_version_id?: string;
  config?: SubscriptionConfig;
  /** crawl のとき：リンク先 og:image の取得（未指定なら取得しない） */
  item_images?: ItemImagesInstruction;
  /** crawl のとき：詳細ページ取得（config.detail があるとき）。skip_keys は現行方式で取得済みの item */
  detail?: { scheme: string; skip_keys: string[] };
  /** probe のとき */
  probe_id?: string;
  probe?: ProbeRequest;
}

/**
 * trial: 未判定。最大数件で試し、見つかればそのまま取得を続ける（結果は API が購読に記憶する）
 * on: 取得する。skip_keys（画像あり・確認済み）の item は取得しない
 */
export interface ItemImagesInstruction {
  mode: "trial" | "on";
  skip_keys: string[];
}

export type ProbeRequest =
  | { kind: "discover"; url: string }
  | { kind: "extract"; config: SubscriptionConfig; max_pages?: number; methods?: ("http" | "browser")[] }
  | { kind: "inspect"; url: string; method: "http" | "browser"; selector: { css: string } | { xpath: string }; wait_ms?: number }
  /** 詳細ページの構造調査（DOMアウトライン・メタ情報） */
  | { kind: "outline"; urls: string[]; method: "http" | "browser" }
  /** 詳細ページ取得ルールの試行 */
  | { kind: "detail"; config: SubscriptionConfig; urls: string[] };

export type PageKind = "initial" | "navigate" | "click_replace" | "click_append";

export interface SubmittedItem {
  identity_key: string | null;
  identity_error?: string;
  content_hash: string;
  valid: boolean;
  failures?: { field: string; status: string; reason?: string }[];
  position: number;
  data: ItemData;
  /** リンク先の og:image を確認した結果（確認しなかった item には付けない） */
  image_lookup?: { url: string | null };
  /** 詳細ページから取得した値（取得を試みた item のみ） */
  detail?: ItemDetailResult;
}

export interface ItemDetailResult {
  scheme: string;
  url: string;
  ok: boolean;
  http_status: number | null;
  error?: string;
  data?: ItemData;
  failures?: { field: string; status: string; reason?: string }[];
}

export interface PageSubmission {
  lease_token: string;
  submission_key: string;
  page: {
    seq: number;
    kind: PageKind;
    url: string | null;
    fetched_at: string;
    http_status: number | null;
    http_status_source: "main_document" | "none";
    action_result: string | null;
    extract_status: "success" | "failed" | "skipped";
    item_count: number;
    field_failures?: FieldFailureStats;
    list_signature?: string;
    error?: string | null;
    subresource_failures?: number;
    snapshot_key?: string | null;
    timings?: Record<string, number>;
  };
  channel?: { data: ChannelData; content_hash: string } | null;
  items: SubmittedItem[];
}

export type RunStatus = "queued" | "running" | "completed" | "partial" | "failed";
export type ExtractStatus = "success" | "failed" | "skipped";
export type ChangeStatus = "initial" | "changed" | "unchanged" | "unknown";
export type EndReason =
  | "single_page"
  | "no_next"
  | "next_disabled"
  | "cycle_detected"
  | "max_pages"
  | "max_actions"
  | "max_duration"
  | "wait_timeout"
  | "error"
  | "config_error"
  | "robots_disallowed"
  | "lease_expired";
export type ErrorStage = "fetch" | "robots" | "wait" | "extract" | "paging" | "submit" | "internal";

export interface CompleteSubmission {
  lease_token: string;
  submission_key: string;
  /** VPS側で判断した巡回の結果。最終的な run_status/change_status は API が決める */
  traversal: "complete" | "incomplete";
  end_reason: EndReason;
  extract_status: ExtractStatus;
  error_stage?: ErrorStage | null;
  error_detail?: string | null;
  pages_fetched: number;
  actions_performed: number;
  started_at: string;
  finished_at: string;
  worker_id: string;
  crawler_version: string;
  engine_version: string;
  /** 一時的失敗（再試行対象）か */
  retryable?: boolean;
  /** リンク先 og:image の試行結果 */
  item_images?: { mode: "trial" | "on"; tried: number; found: number };
  /** 詳細ページ取得の結果 */
  detail?: { tried: number; ok: number };
}

export interface ProbeResultSubmission {
  lease_token: string;
  submission_key: string;
  status: "ok" | "error";
  error?: string;
  summary: unknown;
}

/** 実行結果から change_status / run_status を決める（docs/design.md §5.4） */
export function decideRunOutcome(p: {
  baselineStatusBefore: "none" | "partial" | "complete";
  traversal: "complete" | "incomplete";
  extractStatus: ExtractStatus;
  fatal: boolean;
  newItems: number;
  updatedItems: number;
  channelChanged: boolean;
  anyDataObtained: boolean;
  /** 識別方式変更による再基準化 */
  rebaseline: boolean;
}): { runStatus: RunStatus; changeStatus: ChangeStatus; baselineStatusAfter: "none" | "partial" | "complete"; baselineIncomplete: boolean } {
  const completed = p.traversal === "complete" && p.extractStatus === "success" && !p.fatal;
  const runStatus: RunStatus = completed ? "completed" : p.anyDataObtained ? "partial" : "failed";
  if (p.baselineStatusBefore !== "complete" || p.rebaseline) {
    if (!p.anyDataObtained) return { runStatus, changeStatus: "unknown", baselineStatusAfter: p.baselineStatusBefore, baselineIncomplete: true };
    return {
      runStatus,
      changeStatus: "initial",
      baselineStatusAfter: completed ? "complete" : "partial",
      baselineIncomplete: !completed,
    };
  }
  if (p.newItems > 0 || p.updatedItems > 0 || p.channelChanged)
    return { runStatus, changeStatus: "changed", baselineStatusAfter: "complete", baselineIncomplete: false };
  if (completed) return { runStatus, changeStatus: "unchanged", baselineStatusAfter: "complete", baselineIncomplete: false };
  return { runStatus, changeStatus: "unknown", baselineStatusAfter: "complete", baselineIncomplete: false };
}
