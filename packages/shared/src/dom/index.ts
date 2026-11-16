// ブラウザへ注入するバンドルのエントリ。window.__ws に公開する。
import type { SubscriptionConfig, Cond } from "../config.js";
import { extractPage, type ExtractEnv } from "./extract.js";
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
  buildOutline,
  inspectSelector,
  serialize: () => "<!DOCTYPE html>\n" + document.documentElement.outerHTML,
};
