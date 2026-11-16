// ブラウザへ注入するバンドルのエントリ。window.__ws に公開する。
import type { SubscriptionConfig, Cond } from "../config.js";
import { extractPage, extractItemFrom, type ExtractEnv } from "./extract.js";
import type { FieldRule } from "../config.js";
import type { FieldFailureStats } from "../protocol.js";
import { evalCond, installTracker, listSnapshot, inspectNext, type ListSnapshot } from "./wait.js";
import { buildOutline, inspectSelector } from "./outline.js";
export type { Outline, RepeatCandidate, PagingCandidate } from "./outline.js";

export * from "./extract.js";
export * from "./wait.js";

function env(config: SubscriptionConfig, baseUrl?: string): ExtractEnv {
  return { doc: document, baseUrl: baseUrl ?? document.baseURI, timezone: config.timezone };
}

export const api = {
  installTracker,
  extract: (config: SubscriptionConfig, baseUrl?: string) => extractPage(config, env(config, baseUrl)),
  evalCond: (cond: Cond, config: SubscriptionConfig, before: ListSnapshot | null) => evalCond(cond, config, env(config), before),
  listSnapshot: (config: SubscriptionConfig) => listSnapshot(config, env(config)),
  inspectNext: (config: SubscriptionConfig) => inspectNext(config, env(config)),
  /** 詳細ページ：文書全体を起点に item フィールドを評価する */
  extractDetail: (fields: Record<string, FieldRule>, timezone: string, baseUrl?: string) => {
    const stats: FieldFailureStats = {};
    const r = extractItemFrom(document, fields, { doc: document, baseUrl: baseUrl ?? document.baseURI, timezone }, stats);
    return { data: r.data, failures: r.failures, field_failures: stats };
  },
  /** 文書のメタ情報（title / description / og:*） */
  pageMeta: () => {
    const m = (k: string) => document.querySelector(`meta[property="${k}"], meta[name="${k}"]`)?.getAttribute("content") ?? null;
    return { title: document.title, description: m("description"), og_title: m("og:title"), og_description: m("og:description"), og_image: m("og:image") };
  },
  buildOutline,
  inspectSelector,
  serialize: () => "<!DOCTYPE html>\n" + document.documentElement.outerHTML,
};
