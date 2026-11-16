// 待機条件の評価（ブラウザ内）。docs/design.md §4.5
import type { Cond, Selector, SubscriptionConfig } from "../config.js";
import { selectNodes, type ExtractEnv } from "./extract.js";

interface MutationRec {
  t: number;
  target: Node;
}

interface Tracker {
  installedAt: number;
  muts: MutationRec[];
}

declare global {
  interface Window {
    __wsTracker?: Tracker;
  }
}

export function installTracker(): void {
  if (window.__wsTracker) return;
  const tr: Tracker = { installedAt: Date.now(), muts: [] };
  window.__wsTracker = tr;
  const obs = new MutationObserver((list) => {
    const now = Date.now();
    for (const m of list) tr.muts.push({ t: now, target: m.target });
    if (tr.muts.length > 5000) tr.muts.splice(0, tr.muts.length - 2000);
  });
  obs.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
}

export interface ListSnapshot {
  count: number;
  signature: string;
  url: string;
}

function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(16);
}

export function listSnapshot(config: SubscriptionConfig, env: ExtractEnv): ListSnapshot {
  const sel = config.extract ? selectNodes(env.doc, config.extract.items.select, env) : { ok: false as const };
  const nodes = sel.ok ? sel.nodes : [];
  return { count: nodes.length, signature: djb2(nodes.map((n) => (n.textContent ?? "").replace(/\s+/g, " ")).join("\u0001")), url: location.href };
}

function isVisible(n: Node): boolean {
  if (n.nodeType !== 1) return false;
  const el = n as HTMLElement;
  const st = getComputedStyle(el);
  if (st.display === "none" || st.visibility === "hidden" || Number(st.opacity) === 0) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

export interface CondResult {
  ok: boolean;
  /** 未達条件の説明（タイムアウト時の記録用） */
  detail: string;
}

export function evalCond(cond: Cond, config: SubscriptionConfig, env: ExtractEnv, before: ListSnapshot | null): CondResult {
  const sel = (s: Selector) => {
    const r = selectNodes(env.doc, s, env);
    if (!r.ok) throw new Error(r.error);
    return r.nodes;
  };
  const desc = (s: Selector) => ("css" in s ? `css(${s.css})` : `xpath(${s.xpath})`);
  if ("exists" in cond) {
    const ok = sel(cond.exists).length > 0;
    return { ok, detail: `exists ${desc(cond.exists)}=${ok}` };
  }
  if ("visible" in cond) {
    const ok = sel(cond.visible).some(isVisible);
    return { ok, detail: `visible ${desc(cond.visible)}=${ok}` };
  }
  if ("gone" in cond) {
    const ok = sel(cond.gone).length === 0;
    return { ok, detail: `gone ${desc(cond.gone)}=${ok}` };
  }
  if ("hidden" in cond) {
    const ok = !sel(cond.hidden).some(isVisible);
    return { ok, detail: `hidden ${desc(cond.hidden)}=${ok}` };
  }
  if ("item_count_at_least" in cond) {
    const n = listSnapshot(config, env).count;
    return { ok: n >= cond.item_count_at_least, detail: `item_count ${n}>=${cond.item_count_at_least}` };
  }
  if ("item_count_changed" in cond) {
    const n = listSnapshot(config, env).count;
    const ok = before ? n !== before.count : true;
    return { ok, detail: `item_count_changed ${before?.count}->${n}` };
  }
  if ("items_changed" in cond) {
    const s = listSnapshot(config, env);
    const ok = before ? s.signature !== before.signature : true;
    return { ok, detail: `items_changed=${ok}` };
  }
  if ("url_changed" in cond) {
    const ok = before ? location.href !== before.url : true;
    return { ok, detail: `url_changed=${ok}` };
  }
  if ("stable" in cond) {
    const tr = window.__wsTracker;
    const targets = sel(cond.stable.target);
    if (!tr || targets.length === 0) return { ok: false, detail: `stable ${desc(cond.stable.target)} target_missing` };
    const now = Date.now();
    let last = tr.installedAt;
    for (let i = tr.muts.length - 1; i >= 0; i--) {
      const m = tr.muts[i];
      if (targets.some((t) => t === m.target || t.contains(m.target))) {
        last = Math.max(last, m.t);
        break;
      }
    }
    const quiet = now - last;
    return { ok: quiet >= cond.stable.for_ms, detail: `stable ${desc(cond.stable.target)} quiet=${quiet}ms/${cond.stable.for_ms}ms` };
  }
  if ("all" in cond) {
    const rs = cond.all.map((c) => evalCond(c, config, env, before));
    return { ok: rs.every((r) => r.ok), detail: `all[${rs.map((r) => (r.ok ? "✓" : "✗") + r.detail).join("; ")}]` };
  }
  if ("any" in cond) {
    const rs = cond.any.map((c) => evalCond(c, config, env, before));
    return { ok: rs.some((r) => r.ok), detail: `any[${rs.map((r) => (r.ok ? "✓" : "✗") + r.detail).join("; ")}]` };
  }
  if ("not" in cond) {
    const r = evalCond(cond.not, config, env, before);
    return { ok: !r.ok, detail: `not(${r.detail})` };
  }
  return { ok: false, detail: "unknown_condition" };
}

/** 次へ要素の状態 */
export function inspectNext(config: SubscriptionConfig, env: ExtractEnv): { count: number; index: number | null; disabled: boolean; error?: string } {
  const p = config.paging;
  if (!p.next) return { count: 0, index: null, disabled: false };
  const r = selectNodes(env.doc, p.next, env);
  if (!r.ok) return { count: 0, index: null, disabled: false, error: r.error };
  const nodes = r.nodes.filter((n) => n.nodeType === 1) as Element[];
  if (nodes.length === 0) return { count: 0, index: null, disabled: false };
  let index: number;
  if (p.pick === "only") {
    if (nodes.length > 1) return { count: nodes.length, index: null, disabled: false, error: "multiple_next_elements" };
    index = 0;
  } else if (p.pick === "first") index = 0;
  else if (p.pick === "last") index = nodes.length - 1;
  else {
    index = Number(p.pick.split(":")[1]);
    if (index >= nodes.length) return { count: nodes.length, index: null, disabled: false, error: "pick_index_out_of_range" };
  }
  const el = nodes[index];
  const disabled = p.disabled_when.some((d) => {
    if ("attr" in d) return el.hasAttribute(d.attr);
    if ("attr_equals" in d) return el.getAttribute(d.attr_equals[0]) === d.attr_equals[1];
    return el.classList.contains(d.has_class);
  });
  el.setAttribute("data-ws-next", String(Date.now()));
  return { count: nodes.length, index, disabled };
}
