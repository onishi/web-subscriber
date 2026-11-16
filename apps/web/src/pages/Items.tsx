import { useState } from "react";
import { Link } from "react-router-dom";
import { api, fmtDateValue, fmtTime } from "../api.js";
import { useApi } from "../hooks.js";

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

export function ItemList({
  subscriptionId,
  setId,
  view: initialView = "new",
  showViewTabs = false,
  params,
  fields,
}: {
  subscriptionId?: string;
  setId?: string;
  view?: string;
  showViewTabs?: boolean;
  /** 追加の検索条件（カスタムフィールド f.* / sort） */
  params?: Record<string, string>;
  fields?: FieldDef[];
}) {
  const [view, setView] = useState(initialView);
  const [unread, setUnread] = useState(false);
  const [offset, setOffset] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const q = new URLSearchParams({ view, offset: String(offset), limit: "50" });
  if (unread) q.set("unread", "1");
  if (subscriptionId) q.set("subscription_id", subscriptionId);
  if (setId) q.set("set_id", setId);
  for (const [k, v] of Object.entries(params ?? {})) if (v) q.set(k, v);
  const { data, error, reload, setData } = useApi<{ items: ItemRow[]; has_more: boolean }>(`/items?${q}`);

  const markRead = async (it: ItemRow, read: boolean) => {
    await api(`/items/${it.id}/read`, { method: read ? "PUT" : "DELETE" });
    setData((d) => d && { ...d, items: d.items.map((x) => (x.id === it.id ? { ...x, is_read: read, updated_mark: read ? false : x.updated_mark } : x)) });
  };

  return (
    <div>
      <div className="row" style={{ marginBottom: 8 }}>
        {showViewTabs && (
          <div className="tabs" style={{ marginBottom: 0 }}>
            {[
              ["new", "すべて"],
              ["updated", "更新"],
              ["baseline", "基準データ"],
            ].map(([v, l]) => (
              <button key={v} className={view === v ? "on" : ""} onClick={() => (setView(v), setOffset(0))}>
                {l}
              </button>
            ))}
          </div>
        )}
        <label className="row small">
          <input type="checkbox" checked={unread} onChange={(e) => (setUnread(e.target.checked), setOffset(0))} /> 未読のみ
        </label>
        <span className="spacer" />
        <button
          onClick={async () => {
            await api("/items/mark-read", { method: "POST", json: subscriptionId ? { subscription_id: subscriptionId } : setId ? { set_id: setId } : {} });
            void reload();
          }}
        >
          すべて既読
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {data && data.items.length === 0 && <p className="muted">item はありません。</p>}
      {data?.items.map((it) => (
        <div key={it.id}>
          <div
            className={`item ${it.is_read ? "read" : ""} ${it.image_url ? "has-thumb" : ""}`}
            onClick={() => {
              setOpen(open === it.id ? null : it.id);
              if (!it.is_read || it.updated_mark) void markRead(it, true);
            }}
          >
            {it.image_url && <img className="thumb" src={it.image_url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />}
            <div>
              <div className="row">
                {!it.is_read && !it.is_baseline && <span className="badge accent">未読</span>}
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
          </div>
          {open === it.id && <ItemDetail id={it.id} onUnread={() => markRead(it, false)} />}
        </div>
      ))}
      <div className="row" style={{ marginTop: 10 }}>
        {offset > 0 && <button onClick={() => setOffset(Math.max(0, offset - 50))}>前へ</button>}
        {data?.has_more && <button onClick={() => setOffset(offset + 50)}>次へ</button>}
      </div>
    </div>
  );
}

function TextView({ t }: { t: any }) {
  if (!t) return null;
  if (t.type === "html" || t.type === "xhtml") return <div className="detail" dangerouslySetInnerHTML={{ __html: sanitize(t.value) }} />;
  return <div className="detail" style={{ whiteSpace: "pre-wrap" }}>{t.value}</div>;
}

/** 表示前の簡易サニタイズ（script/style/on*属性/javascript:URL を除去） */
function sanitize(html: string): string {
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, "text/html");
  doc.querySelectorAll("script,style,iframe,object,embed,form,link,meta").forEach((e) => e.remove());
  doc.querySelectorAll("*").forEach((el) => {
    for (const a of Array.from(el.attributes)) {
      if (/^on/i.test(a.name) || (/^(href|src|xlink:href|action)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) el.removeAttribute(a.name);
    }
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
  return (
    <div className="panel">
      <div className="row">
        {alt[0] && (
          <a href={alt[0].href} target="_blank" rel="noopener noreferrer">
            元ページを開く ↗
          </a>
        )}
        <span className="spacer" />
        <button onClick={onUnread}>未読に戻す</button>
      </div>
      {data.custom_fields?.length > 0 && <CustomFieldsEditor itemId={id} fields={data.custom_fields} reload={reload} />}
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
      {d.summary && (
        <>
          <h3>要約{d.native?.description_role === "unknown" && <span className="muted small">（RSS description：全文の場合あり）</span>}</h3>
          <TextView t={d.summary} />
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
            <TextView t={d.content} />
          )}
        </>
      )}
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

export function ItemsPage() {
  return (
    <div>
      <h2>新着</h2>
      <p className="muted small">初回取得分（基準データ）は既読として表示します。内容が更新された item には「更新」印が付きます。</p>
      <ItemList />
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
