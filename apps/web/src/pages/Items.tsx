import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, fmtDateValue, fmtTime } from "../api.js";
import { useApi } from "../hooks.js";
import { notifySetsChanged, useSets } from "./Sets.js";

interface ItemRow {
  id: string;
  subscription_id: string;
  subscription_title: string;
  title_text: string | null;
  primary_link: string | null;
  image_url: string | null;
  summary: string | null;
  summary_type: string | null;
  published_at: any;
  updated_at: any;
  is_baseline: number;
  first_seen_at: string;
  last_changed_at: string | null;
  revision_count: number;
  is_read: boolean;
  updated_mark: boolean;
  /** セット表示時のカスタムフィールドの値 */
  fields?: Record<string, (string | number | boolean | null)[]>;
  /** 手で直したフィールドのキー */
  fields_manual?: string[];
}

export interface FieldDef {
  id: string;
  key: string;
  label: string;
  type: "text" | "list" | "date" | "number" | "boolean";
  description: string;
}

export const fmtFieldValue = (type: string, v: unknown) => (type === "boolean" ? (v ? "はい" : "いいえ") : String(v));

const stripTags = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

const PAGE = 50;
type Density = "cozy" | "compact";
const loadDensity = (): Density => {
  try {
    return localStorage.getItem("ws-density") === "compact" ? "compact" : "cozy";
  } catch {
    return "cozy";
  }
};
/** 入力欄にフォーカスがあるときや修飾キー付きのときはショートカットを無視する */
export const isTypingTarget = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return e.metaKey || e.ctrlKey || e.altKey || !!(t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)));
};
const shortTime = (iso: string) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date();
  const opt: Intl.DateTimeFormatOptions = { timeZone: "Asia/Tokyo" };
  const sameDay = d.toLocaleDateString("ja-JP", opt) === today.toLocaleDateString("ja-JP", opt);
  return sameDay
    ? d.toLocaleTimeString("ja-JP", { ...opt, hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("ja-JP", { ...opt, month: "numeric", day: "numeric" });
};

export function ItemList({
  subscriptionId,
  setId,
  view: initialView = "new",
  showViewTabs = false,
  params,
  fields,
  onRead,
}: {
  subscriptionId?: string;
  setId?: string;
  view?: string;
  showViewTabs?: boolean;
  /** 追加の検索条件（カスタムフィールド f.* / sort） */
  params?: Record<string, string>;
  fields?: FieldDef[];
  /** 既読・未読を変えたとき（未読数の更新用） */
  onRead?: () => void;
}) {
  const [view, setView] = useState(initialView);
  const [unread, setUnread] = useState(false);
  const [items, setItems] = useState<ItemRow[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [cursor, setCursor] = useState(-1);
  const [density, setDensity] = useState<Density>(loadDensity);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());
  const q = new URLSearchParams({ view, limit: String(PAGE) });
  if (unread) q.set("unread", "1");
  if (subscriptionId) q.set("subscription_id", subscriptionId);
  if (setId) q.set("set_id", setId);
  for (const [k, v] of Object.entries(params ?? {})) if (v) q.set(k, v);
  const qs = q.toString();
  const reqId = useRef(0);

  const load = useCallback(
    async (offset: number) => {
      const id = ++reqId.current;
      setLoading(true);
      try {
        const d = await api<{ items: ItemRow[]; has_more: boolean }>(`/items?${qs}&offset=${offset}`);
        if (id !== reqId.current) return;
        setItems((prev) => (offset === 0 ? d.items : [...prev, ...d.items.filter((x) => !prev.some((p) => p.id === x.id))]));
        setHasMore(d.has_more);
        setError(null);
      } catch (e) {
        if (id === reqId.current) setError((e as Error).message);
      } finally {
        if (id === reqId.current) {
          setLoading(false);
          setLoaded(true);
        }
      }
    },
    [qs],
  );
  const reload = useCallback(() => {
    setCursor(-1);
    setOpen(null);
    return load(0);
  }, [load]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const loadMore = useCallback(() => {
    if (!loading && hasMore) void load(items.length);
  }, [loading, hasMore, load, items.length]);

  // 最後まで見えたら続きを読み込む
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver((es) => es.some((x) => x.isIntersecting) && loadMore(), { rootMargin: "400px" });
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore]);

  const markRead = useCallback(
    async (it: ItemRow, read: boolean) => {
      setItems((xs) => xs.map((x) => (x.id === it.id ? { ...x, is_read: read, updated_mark: read ? false : x.updated_mark } : x)));
      await api(`/items/${it.id}/read`, { method: read ? "PUT" : "DELETE" });
      onRead?.();
    },
    [onRead],
  );
  const markAllRead = async () => {
    if (!window.confirm(setId || subscriptionId ? "この一覧をすべて既読にしますか？" : "すべての情報を既読にしますか？")) return;
    await api("/items/mark-read", { method: "POST", json: subscriptionId ? { subscription_id: subscriptionId } : setId ? { set_id: setId } : {} });
    onRead?.();
    void reload();
  };
  const toggleDensity = () =>
    setDensity((d) => {
      const n = d === "cozy" ? "compact" : "cozy";
      try {
        localStorage.setItem("ws-density", n);
      } catch {
        /* 保存できなくても表示は切り替える */
      }
      return n;
    });

  /** カーソルを i に移す。読み進めたものは既読にする。詳細を開いていれば次の詳細も開く */
  const moveTo = useCallback(
    (i: number) => {
      if (i < 0 || i >= items.length) return;
      const it = items[i];
      setCursor(i);
      if (open) setOpen(it.id);
      if (!it.is_read || it.updated_mark) void markRead(it, true);
      requestAnimationFrame(() => rowRefs.current.get(it.id)?.scrollIntoView({ block: open ? "start" : "nearest" }));
      if (i >= items.length - 5) loadMore();
    },
    [items, open, markRead, loadMore],
  );

  const state = useRef({ items, cursor, open, moveTo, markRead, loadMore });
  state.current = { items, cursor, open, moveTo, markRead, loadMore };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e)) return;
      const { items, cursor, open, moveTo, markRead } = state.current;
      const cur = items[cursor];
      switch (e.key) {
        case "j":
        case "ArrowDown":
          if (e.key === "ArrowDown" && cursor < 0) return;
          e.preventDefault();
          moveTo(cursor + 1);
          break;
        case "k":
        case "ArrowUp":
          if (e.key === "ArrowUp" && cursor < 0) return;
          e.preventDefault();
          moveTo(Math.max(0, cursor - 1));
          break;
        case "o":
        case "Enter":
          if (!cur) return;
          e.preventDefault();
          setOpen(open === cur.id ? null : cur.id);
          if (!cur.is_read || cur.updated_mark) void markRead(cur, true);
          requestAnimationFrame(() => rowRefs.current.get(cur.id)?.scrollIntoView({ block: "start" }));
          break;
        case "Escape":
          if (open) setOpen(null);
          break;
        case "v":
          if (cur?.primary_link) {
            e.preventDefault();
            window.open(cur.primary_link, "_blank", "noopener,noreferrer");
            if (!cur.is_read) void markRead(cur, true);
          }
          break;
        case "m":
          if (cur) void markRead(cur, !cur.is_read || cur.updated_mark ? true : false);
          break;
        case "u":
          setUnread((x) => !x);
          break;
        case "d":
          toggleDensity();
          break;
        case "r":
          void reload();
          break;
        case "A":
          void markAllRead();
          break;
        case "g":
          moveTo(0);
          break;
        case "G":
          moveTo(items.length - 1);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload]);

  const compact = density === "compact";
  return (
    <div>
      <div className="row list-toolbar">
        {showViewTabs && (
          <div className="tabs" style={{ marginBottom: 0 }}>
            {[
              ["new", "すべて"],
              ["updated", "更新"],
              ["baseline", "基準データ"],
            ].map(([v, l]) => (
              <button key={v} className={view === v ? "on" : ""} onClick={() => setView(v)}>
                {l}
              </button>
            ))}
          </div>
        )}
        <label className="row small" title="u">
          <input type="checkbox" checked={unread} onChange={(e) => setUnread(e.target.checked)} /> 未読のみ
        </label>
        <div className="seg small" role="group" aria-label="表示の密度">
          <button type="button" className={compact ? "" : "on"} onClick={() => compact && toggleDensity()} title="d">
            詳しく
          </button>
          <button type="button" className={compact ? "on" : ""} onClick={() => !compact && toggleDensity()} title="d">
            1行
          </button>
        </div>
        <span className="spacer" />
        <button className="link small shortcut-link" onClick={() => window.dispatchEvent(new Event("ws-help"))}>
          ? ショートカット
        </button>
        <button onClick={() => void markAllRead()} title="Shift+A">
          すべて既読
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {loaded && items.length === 0 && !error && <p className="muted">{unread ? "未読の情報はありません。" : "情報はありません。"}</p>}
      <div className={compact ? "items compact" : "items"}>
        {items.map((it, i) => {
          const isNew = !it.is_read && !it.is_baseline;
          return (
            <div key={it.id}>
              <div
                ref={(el) => {
                  if (el) rowRefs.current.set(it.id, el);
                  else rowRefs.current.delete(it.id);
                }}
                className={`item ${it.is_read ? "read" : ""} ${!compact && it.image_url ? "has-thumb" : ""} ${cursor === i ? "cursor" : ""} ${open === it.id ? "opened" : ""}`}
                onClick={() => {
                  setCursor(i);
                  setOpen(open === it.id ? null : it.id);
                  if (!it.is_read || it.updated_mark) void markRead(it, true);
                }}
              >
                {compact ? (
                  <>
                    <span className={`dot ${isNew ? "on" : it.updated_mark ? "warn" : ""}`} title={isNew ? "未読" : it.updated_mark ? "更新" : ""} />
                    <span className="title">{it.title_text || it.primary_link || "(無題)"}</span>
                    {!subscriptionId && <span className="src muted">{it.subscription_title}</span>}
                    <span className="time muted" title={`検出 ${fmtTime(it.last_changed_at ?? it.first_seen_at)}`}>
                      {shortTime(it.last_changed_at ?? it.first_seen_at)}
                    </span>
                  </>
                ) : (
                  <>
                    {it.image_url && <img className="thumb" src={it.image_url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />}
                    <div>
                      <div className="row">
                        {isNew && <span className="badge accent">未読</span>}
                        {it.updated_mark && <span className="badge warn">更新</span>}
                        {!!it.is_baseline && <span className="badge">基準データ</span>}
                        <span className="title">{it.title_text || it.primary_link || "(無題)"}</span>
                      </div>
                      {it.summary && <div className="muted small">{stripTags(it.summary).slice(0, 140)}</div>}
                      {fields && it.fields && Object.keys(it.fields).length > 0 && (
                        <div className="row small field-values">
                          {fields
                            .filter((f) => it.fields![f.key]?.length)
                            .map((f) => (
                              <span key={f.key} className="field-value" title={it.fields_manual?.includes(f.key) ? "手で修正した値" : "AIが抽出した値"}>
                                <span className="muted">{f.label}</span> {it.fields![f.key].map((v) => fmtFieldValue(f.type, v)).join("・")}
                                {it.fields_manual?.includes(f.key) && <span className="manual-mark">✎</span>}
                              </span>
                            ))}
                        </div>
                      )}
                    </div>
                    <div className="small muted" style={{ textAlign: "right" }}>
                      {!subscriptionId && (
                        <div>
                          <Link to={`/subscriptions/${it.subscription_id}`} onClick={(e) => e.stopPropagation()}>
                            {it.subscription_title}
                          </Link>
                        </div>
                      )}
                      <div title="公開日時（配信元の表記）">{fmtDateValue(it.published_at) || fmtDateValue(it.updated_at) || ""}</div>
                      <div title="検出日時">検出 {fmtTime(it.last_changed_at ?? it.first_seen_at)}</div>
                    </div>
                  </>
                )}
              </div>
              {open === it.id && <ItemDetail id={it.id} onUnread={() => markRead(it, false)} />}
            </div>
          );
        })}
      </div>
      <div ref={sentinel} className="small muted list-end">
        {loading ? "読み込み中…" : hasMore ? <button onClick={loadMore}>さらに読み込む</button> : loaded && items.length > 0 ? `${items.length} 件` : null}
      </div>
    </div>
  );
}

function TextView({ t, base }: { t: any; base?: string | null }) {
  if (!t) return null;
  if (t.type === "html" || t.type === "xhtml") return <div className="detail" dangerouslySetInnerHTML={{ __html: sanitize(t.value, t.base ?? base) }} />;
  return <div className="detail" style={{ whiteSpace: "pre-wrap" }}>{t.value}</div>;
}

/** 相対 URL を元ページの URL で絶対 URL にする（できなければそのまま） */
const absUrl = (u: string, base?: string | null) => {
  try {
    return new URL(u.trim(), base ?? undefined).href;
  } catch {
    return u;
  }
};
// 遅延読み込み用に本当の画像 URL を入れておく属性
const LAZY_SRC = ["data-src", "data-original", "data-lazy-src", "data-echo", "data-url"];

/**
 * 表示前の簡易サニタイズ（script/style/on*属性/javascript:URL を除去）。
 * あわせて、元ページからの相対パスの画像・リンクを元ページの URL で補う
 */
function sanitize(html: string, base?: string | null): string {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  doc.querySelectorAll("script,style,iframe,object,embed,form,link,meta").forEach((e) => e.remove());
  doc.querySelectorAll("*").forEach((el) => {
    for (const a of Array.from(el.attributes)) {
      if (/^on/i.test(a.name) || (/^(href|src|xlink:href|action|poster)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) el.removeAttribute(a.name);
    }
    if (el.tagName === "IMG" || el.tagName === "SOURCE") {
      // 遅延読み込みの画像は本当の URL を src に戻す（src がないか、データ URL の仮画像のとき）
      const lazy = LAZY_SRC.map((n) => el.getAttribute(n)).find((v) => v && !/^\s*javascript:/i.test(v));
      const src = el.getAttribute("src");
      if (lazy && (!src || /^data:/i.test(src))) el.setAttribute("src", lazy);
      const lazySet = el.getAttribute("data-srcset");
      if (lazySet && !el.getAttribute("srcset")) el.setAttribute("srcset", lazySet);
      el.setAttribute("loading", "lazy");
      el.setAttribute("referrerpolicy", "no-referrer");
    }
    for (const name of ["src", "href", "poster"]) {
      const v = el.getAttribute(name);
      if (v && !/^(#|data:|mailto:|tel:)/i.test(v.trim())) el.setAttribute(name, absUrl(v, base));
    }
    const srcset = el.getAttribute("srcset");
    if (srcset)
      el.setAttribute(
        "srcset",
        srcset
          .split(",")
          .map((part) => {
            const [u, ...rest] = part.trim().split(/\s+/);
            return u ? [absUrl(u, base), ...rest].join(" ") : "";
          })
          .filter(Boolean)
          .join(", "),
      );
    if (el.tagName === "A") {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
  });
  return doc.body.firstElementChild?.innerHTML ?? "";
}

function ItemDetail({ id, onUnread }: { id: string; onUnread: () => void }) {
  const { data, reload } = useApi<any>(`/items/${id}`);
  if (!data) return <div className="panel muted">読み込み中…</div>;
  const d = data.data;
  const alt = d.links.filter((l: any) => l.rel === "alternate");
  const enc = d.links.filter((l: any) => l.rel === "enclosure");
  const authors = data.effective.authors;
  // 本文中の相対パスを補うための元ページの URL
  const pageUrl: string | null = alt[0]?.href ?? null;
  return (
    <div className="panel">
      <div className="row">
        {alt[0] && (
          <a href={alt[0].href} target="_blank" rel="noopener noreferrer">
            元ページを開く ↗
          </a>
        )}
        <span className="small muted">
          {fmtDateValue(d.published_at) ? `公開 ${fmtDateValue(d.published_at)}・` : ""}検出 {fmtTime(data.first_seen_at)}
        </span>
        <span className="spacer" />
        <button onClick={onUnread} title="m">
          未読に戻す
        </button>
      </div>
      {d.summary && (
        <>
          <h3>要約{d.native?.description_role === "unknown" && <span className="muted small">（RSS description：全文の場合あり）</span>}</h3>
          <TextView t={d.summary} base={pageUrl} />
        </>
      )}
      {d.content && (
        <>
          <h3>本文</h3>
          {d.content.kind === "external" ? (
            <a href={d.content.src} target="_blank" rel="noopener noreferrer">
              外部コンテンツ（{d.content.type ?? "不明な形式"}）
            </a>
          ) : d.content.encoding === "base64" ? (
            <p className="muted">{d.content.type}（base64）</p>
          ) : (
            <TextView t={d.content} base={pageUrl} />
          )}
        </>
      )}
      {data.custom_fields?.length > 0 && <CustomFieldsEditor itemId={id} fields={data.custom_fields} reload={reload} />}
      <details className="item-meta">
        <summary className="small muted">詳しい情報（日時・著者・取得元など）</summary>
        <div className="kv small" style={{ margin: "10px 0" }}>
          {data.detail_checked_at && (
            <>
              <div>リンク先</div>
              <div>
                {data.detail_status === "ok" ? "詳細ページから取得" : "詳細ページから取得できず"}（{fmtTime(data.detail_checked_at)}）
                {data.detail_data && <span className="muted">：{Object.keys(data.detail_data).filter((k) => !["links", "authors", "contributors", "categories", "native", "extensions"].includes(k) || (Array.isArray(data.detail_data[k]) && data.detail_data[k].length && k !== "extensions" && k !== "links")).join(", ")}</span>}
              </div>
            </>
          )}
          <div>配信元ID</div>
          <div className="mono">{d.source_id ?? "—"}</div>
          <div>公開日時</div>
          <div>
            {fmtDateValue(d.published_at) || "—"} {d.published_at?.tz === "assumed" && <span className="muted">（{d.published_at.assumed_tz}を補完）</span>}
          </div>
          <div>更新日時</div>
          <div>{fmtDateValue(d.updated_at) || "—"}</div>
          <div>検出 / 最終確認</div>
          <div>
            {fmtTime(data.first_seen_at)} / {fmtTime(data.last_seen_at)}
          </div>
          <div>著者</div>
          <div>
            {authors.effective?.map((a: any) => a.name ?? a.email).join(", ") || "—"}
            {authors.from === "channel" && <span className="muted">（チャンネルから継承）</span>}
          </div>
          {d.categories.length > 0 && (
            <>
              <div>カテゴリ</div>
              <div>{d.categories.map((c: any) => c.label ?? c.term).join(", ")}</div>
            </>
          )}
          {enc.length > 0 && (
            <>
              <div>添付</div>
              <div>
                {enc.map((l: any) => (
                  <div key={l.href}>
                    <a href={l.href} target="_blank" rel="noopener noreferrer">
                      {l.href}
                    </a>{" "}
                    <span className="muted">{l.media_type} {l.length_bytes ? `${l.length_bytes} bytes` : ""}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </details>
      {d.native?.format === "html" && Object.keys(d.native.extracted_fields ?? {}).length > 0 && (
        <>
          <h3>追加フィールド</h3>
          <pre>{JSON.stringify(d.native.extracted_fields, null, 2)}</pre>
        </>
      )}
      {data.revisions.length > 1 && (
        <>
          <h3>変更履歴</h3>
          {data.revisions.map((r: any) => (
            <div key={r.id} className="small">
              {fmtTime(r.created_at)} — {r.change_kind === "created" ? "初回取得" : "内容変更"}: {r.data?.title?.value}
            </div>
          ))}
        </>
      )}
      <details>
        <summary className="small muted">正規化データ</summary>
        <pre>{JSON.stringify(d, null, 2)}</pre>
      </details>
    </div>
  );
}

/** 未読数の更新をまとめて通知する（読み進めるたびに一覧を取り直さない） */
let notifyTimer: ReturnType<typeof setTimeout> | null = null;
const notifySetsChangedSoon = () => {
  if (notifyTimer) clearTimeout(notifyTimer);
  notifyTimer = setTimeout(notifySetsChanged, 1500);
};

export function ItemsPage() {
  const [sp, setSp] = useSearchParams();
  const { data: sets } = useSets();
  const list = sets?.sets ?? [];
  const setId = sp.get("set") ?? "";
  // セットの一覧を待たずに読み込みを始める（一覧に無いと分かったら「すべて」に戻す）
  const current = setId && (!sets || list.some((s) => s.id === setId)) ? { id: setId } : null;
  const detail = useApi<{ fields: FieldDef[] }>(current ? `/sets/${current.id}` : null);
  const scopes = ["", ...list.map((s) => s.id)];
  const go = (id: string) => setSp(id ? { set: id } : {}, { replace: false });
  const state = useRef({ scopes, setId, go });
  state.current = { scopes, setId, go };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e)) return;
      const { scopes, setId, go } = state.current;
      const i = Math.max(0, scopes.indexOf(setId));
      if (e.key === "]" || e.key === "[") {
        e.preventDefault();
        go(scopes[(i + (e.key === "]" ? 1 : -1) + scopes.length) % scopes.length]);
      } else if (/^[1-9]$/.test(e.key) && Number(e.key) <= scopes.length) {
        go(scopes[Number(e.key) - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <div>
      <div className="tabs scope-tabs" role="tablist">
        {[{ id: "", name: "すべて", unread_count: 0 }, ...list].map((s, i) => (
          <button key={s.id || "all"} role="tab" aria-selected={setId === s.id || (!current && !s.id)} className={setId === s.id || (!current && !s.id) ? "on" : ""} onClick={() => go(s.id)} title={i < 9 ? `${i + 1}` : undefined}>
            {s.name}
            {s.unread_count > 0 && <span className="count">{s.unread_count}</span>}
          </button>
        ))}
      </div>
      {current ? (
        // フィールドの定義は一覧と並行して読み込み、届いたら値を表示する
        <ItemList key={current.id} setId={current.id} fields={detail.data?.fields} onRead={notifySetsChangedSoon} />
      ) : (
        <ItemList key="all" onRead={notifySetsChangedSoon} />
      )}
    </div>
  );
}

const fmtValues = (type: string, vals: unknown[]) => (vals.length ? vals.map((v) => fmtFieldValue(type, v)).join("・") : "—");

/** item のカスタムフィールド：表示・手動修正・AIの値に戻す・修正履歴 */
function CustomFieldsEditor({ itemId, fields, reload }: { itemId: string; fields: any[]; reload: () => Promise<unknown> }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState<string>("");
  const [err, setErr] = useState<string | null>(null);
  const keyOf = (f: any) => `${f.set_id}:${f.key}`;
  const toDraft = (f: any) => (f.type === "list" ? f.values.join("\n") : f.values[0] === undefined || f.values[0] === null ? "" : String(f.values[0]));
  const fromDraft = (f: any): unknown[] => {
    if (f.type === "list") return draft.split(/\n|、|,/).map((x) => x.trim()).filter(Boolean);
    if (draft.trim() === "") return [];
    if (f.type === "number") return [Number(draft)];
    if (f.type === "boolean") return [draft === "true"];
    return [draft.trim()];
  };
  const sets = [...new Map(fields.map((f) => [f.set_id, f.set_name])).entries()];
  return (
    <div className="custom-fields">
      {sets.map(([setId, setName]) => (
        <div key={setId}>
          <div className="small muted">カスタムフィールド（{setName}）</div>
          <table className="small">
            <tbody>
              {fields
                .filter((f) => f.set_id === setId)
                .map((f) => (
                  <tr key={keyOf(f)}>
                    <td style={{ width: 120 }}>{f.label}</td>
                    <td>
                      {editing === keyOf(f) ? (
                        <form
                          className="row"
                          onSubmit={async (e) => {
                            e.preventDefault();
                            try {
                              await api(`/items/${itemId}/fields/${f.set_id}/${f.key}`, { method: "PUT", json: { values: fromDraft(f) } });
                              setEditing(null);
                              setErr(null);
                              void reload();
                            } catch (e) {
                              setErr((e as Error).message);
                            }
                          }}
                        >
                          {f.type === "list" ? (
                            <textarea rows={3} value={draft} placeholder="1行に1つ" onChange={(e) => setDraft(e.target.value)} />
                          ) : f.type === "boolean" ? (
                            <select value={draft} onChange={(e) => setDraft(e.target.value)}>
                              <option value="">値なし</option>
                              <option value="true">はい</option>
                              <option value="false">いいえ</option>
                            </select>
                          ) : (
                            <input type={f.type === "date" ? "text" : f.type === "number" ? "number" : "text"} placeholder={f.type === "date" ? "YYYY-MM-DD（空欄で値なし）" : "空欄で値なし"} value={draft} onChange={(e) => setDraft(e.target.value)} />
                          )}
                          <button className="primary">保存</button>
                          <button type="button" onClick={() => setEditing(null)}>
                            取消
                          </button>
                          {err && <span className="error">{err}</span>}
                        </form>
                      ) : (
                        <div className="row">
                          <span>{fmtValues(f.type, f.values)}</span>
                          {f.manual ? (
                            <span className="badge warn" title={`${f.manual.by}・${fmtTime(f.manual.at)}`}>
                              手動
                            </span>
                          ) : f.extraction.status === "ok" ? (
                            <span className="badge">AI</span>
                          ) : (
                            <span className="badge">{f.extraction.status === "error" ? "抽出失敗" : "抽出待ち"}</span>
                          )}
                          <button
                            onClick={() => {
                              setDraft(toDraft(f));
                              setErr(null);
                              setEditing(keyOf(f));
                            }}
                          >
                            修正
                          </button>
                          {f.manual && (
                            <button
                              title="手動の値をやめて、AIで抽出し直します"
                              onClick={async () => {
                                await api(`/items/${itemId}/fields/${f.set_id}/${f.key}`, { method: "DELETE" });
                                setTimeout(() => void reload(), 8000);
                                void reload();
                              }}
                            >
                              AIの値に戻す
                            </button>
                          )}
                        </div>
                      )}
                      {f.history.length > 0 && (
                        <details>
                          <summary className="muted">修正履歴（{f.history.length}）</summary>
                          <ul className="muted">
                            {f.history.map((h: any, i: number) => (
                              <li key={i}>
                                {fmtTime(h.at)} {h.by}：{h.action === "set" ? `${fmtValues(f.type, h.before)} → ${fmtValues(f.type, h.after)}` : `AIの値に戻す（直前の値 ${fmtValues(f.type, h.before)}）`}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}
