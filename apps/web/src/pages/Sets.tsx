// セット：複数の購読先をまとめて名前を付けたもの（例「京都の美術館」）
import { useEffect, useState } from "react";
import { Link, NavLink, useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { useApi } from "../hooks.js";
import { ItemList, type FieldDef } from "./Items.js";

export interface SetRow {
  id: string;
  name: string;
  member_count: number;
  unread_count: number;
}

const SETS_CHANGED = "ws-sets-changed";
/** セットの追加・変更をサイドバーなどに知らせる */
export const notifySetsChanged = () => window.dispatchEvent(new Event(SETS_CHANGED));

export function useSets() {
  const r = useApi<{ sets: SetRow[] }>("/sets", { pollMs: 30000 });
  const { reload } = r;
  useEffect(() => {
    const h = () => void reload();
    window.addEventListener(SETS_CHANGED, h);
    return () => window.removeEventListener(SETS_CHANGED, h);
  }, [reload]);
  return r;
}

const errorLabel = (e: unknown) => {
  const code = (e as Error).message;
  return code === "name_taken" ? "同じ名前のセットがあります" : code === "name_required" ? "名前を入力してください" : code;
};

/** サイドバーのセット一覧 */
export function SetsNav() {
  const { data } = useSets();
  return (
    <>
      <div className="nav-heading">
        <span>セット</span>
        <NavLink to="/sets" end className="nav-sub">
          管理
        </NavLink>
      </div>
      {data?.sets.map((s) => (
        <NavLink key={s.id} to={`/sets/${s.id}`} className="nav-set">
          <span>{s.name}</span>
          {s.unread_count > 0 && <span className="count">{s.unread_count}</span>}
        </NavLink>
      ))}
    </>
  );
}

function CreateSetForm({ onCreated }: { onCreated: (id: string) => void }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="row"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          const r = await api<{ set: { id: string } }>("/sets", { method: "POST", json: { name } });
          setName("");
          setErr(null);
          notifySetsChanged();
          onCreated(r.set.id);
        } catch (e) {
          setErr(errorLabel(e));
        }
      }}
    >
      <input type="text" placeholder="セットの名前（例：京都の美術館）" value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
      <button className="primary" disabled={!name.trim()}>
        作成
      </button>
      {err && <span className="error small">{err}</span>}
    </form>
  );
}

export function SetsPage() {
  const nav = useNavigate();
  const { data, reload } = useSets();
  return (
    <div>
      <h2>セット</h2>
      <p className="muted small">複数の購読先をまとめて、名前を付けて読めます。1つの購読先を複数のセットに入れることもできます。</p>
      <div className="panel">
        <CreateSetForm onCreated={(id) => nav(`/sets/${id}`)} />
      </div>
      <div className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>名前</th>
              <th>購読先</th>
              <th>未読</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {data?.sets.map((s) => (
              <tr key={s.id}>
                <td>
                  <Link to={`/sets/${s.id}`}>{s.name}</Link>
                </td>
                <td>{s.member_count}</td>
                <td>{s.unread_count}</td>
                <td>
                  <button
                    className="danger"
                    onClick={async () => {
                      if (!confirm(`セット「${s.name}」を削除しますか？（購読先と item は残ります）`)) return;
                      await api(`/sets/${s.id}`, { method: "DELETE" });
                      notifySetsChanged();
                      void reload();
                    }}
                  >
                    削除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data?.sets.length === 0 && <p className="muted">セットはまだありません。</p>}
      </div>
    </div>
  );
}

export function SetPage() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data, error, reload } = useApi<any>(`/sets/${id}`);
  const subs = useApi<{ subscriptions: any[] }>("/subscriptions");
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<"items" | "members" | "fields" | "publish">("items");
  const [params, setParams] = useState<Record<string, string>>({});
  if (error) return <p className="error">{error === "not_found" ? "セットが見つかりません" : error}</p>;
  if (!data) return <p className="muted">読み込み中…</p>;
  const set = data.set;
  const memberIds = new Set<string>(data.members.map((m: any) => m.id));
  const candidates = (subs.data?.subscriptions ?? []).filter((s) => !memberIds.has(s.id));
  const title = (s: any) => s.display_title || s.channel_title || s.input_url;

  const toggle = async (subId: string, add: boolean) => {
    await api(`/sets/${set.id}/members/${subId}`, { method: add ? "PUT" : "DELETE" });
    notifySetsChanged();
    void reload();
  };

  return (
    <div>
      <div className="row">
        {editing ? (
          <form
            className="row"
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api(`/sets/${set.id}`, { method: "PATCH", json: { name } });
                setEditing(false);
                setErr(null);
                notifySetsChanged();
                void reload();
              } catch (e) {
                setErr(errorLabel(e));
              }
            }}
          >
            <input type="text" value={name} maxLength={60} autoFocus onChange={(e) => setName(e.target.value)} />
            <button className="primary">保存</button>
            <button type="button" onClick={() => setEditing(false)}>
              取消
            </button>
            {err && <span className="error small">{err}</span>}
          </form>
        ) : (
          <>
            <h2>{set.name}</h2>
            <button
              onClick={() => {
                setName(set.name);
                setEditing(true);
              }}
            >
              名前を変更
            </button>
          </>
        )}
        <span className="spacer" />
        <button
          className="danger"
          onClick={async () => {
            if (!confirm(`セット「${set.name}」を削除しますか？（購読先と item は残ります）`)) return;
            await api(`/sets/${set.id}`, { method: "DELETE" });
            notifySetsChanged();
            nav("/sets");
          }}
        >
          削除
        </button>
      </div>
      <div className="row small" style={{ marginBottom: 8 }}>
        {data.members.map((m: any) => (
          <Link key={m.id} to={`/subscriptions/${m.id}`} className="chip">
            {m.channel_logo && <img src={m.channel_logo} alt="" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = "none")} />}
            {title(m)}
          </Link>
        ))}
      </div>
      <div className="tabs">
        <button className={tab === "items" ? "on" : ""} onClick={() => setTab("items")}>
          item
        </button>
        <button className={tab === "members" ? "on" : ""} onClick={() => setTab("members")}>
          購読先（{data.members.length}）
        </button>
        <button className={tab === "fields" ? "on" : ""} onClick={() => setTab("fields")}>
          カスタムフィールド（{data.fields.length}）
        </button>
        <button className={tab === "publish" ? "on" : ""} onClick={() => setTab("publish")}>
          公開{set.is_public ? "中" : ""}
        </button>
      </div>
      {tab === "publish" && <PublishEditor set={set} fields={data.fields} reload={reload} />}
      {tab === "fields" && <FieldsEditor setId={set.id} fields={data.fields} extraction={data.extraction} reload={reload} />}
      {tab === "items" &&
        (data.members.length ? (
          <>
            {data.fields.length > 0 && <FieldFilters setId={set.id} fields={data.fields} value={params} onChange={setParams} />}
            <ItemList key={set.id + JSON.stringify(params)} setId={set.id} params={params} fields={data.fields} />
          </>
        ) : (
          <p className="muted">
            購読先がまだありません。
            <button onClick={() => setTab("members")}>購読先を追加</button>
          </p>
        ))}
      {tab === "members" && (
        <div className="panel">
          {candidates.length > 0 && (
            <div className="row" style={{ marginBottom: 12 }}>
              <select
                value=""
                onChange={(e) => {
                  if (e.target.value) void toggle(e.target.value, true);
                }}
              >
                <option value="">＋ 購読先を追加…</option>
                {candidates.map((s) => (
                  <option key={s.id} value={s.id}>
                    {title(s)}
                  </option>
                ))}
              </select>
            </div>
          )}
          <table>
            <tbody>
              {data.members.map((m: any) => (
                <tr key={m.id}>
                  <td>
                    <Link to={`/subscriptions/${m.id}`}>{title(m)}</Link>
                    <div className="muted small mono">{m.input_url}</div>
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <button onClick={() => void toggle(m.id, false)}>セットから外す</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.members.length === 0 && <p className="muted">購読先はまだありません。</p>}
        </div>
      )}
    </div>
  );
}

/** 購読先ページ：所属するセットの切り替え */
export function SetMembership({ subscriptionId, setIds, onChange }: { subscriptionId: string; setIds: string[]; onChange: () => void }) {
  const { data, reload } = useSets();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const has = new Set(setIds);
  return (
    <div className="row" style={{ flexWrap: "wrap" }}>
      {data?.sets.map((s) => (
        <label key={s.id} className="row small">
          <input
            type="checkbox"
            checked={has.has(s.id)}
            onChange={async (e) => {
              await api(`/sets/${s.id}/members/${subscriptionId}`, { method: e.target.checked ? "PUT" : "DELETE" });
              notifySetsChanged();
              onChange();
            }}
          />
          {s.name}
        </label>
      ))}
      {adding ? (
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api("/sets", { method: "POST", json: { name, subscription_ids: [subscriptionId] } });
              setAdding(false);
              setName("");
              setErr(null);
              notifySetsChanged();
              void reload();
              onChange();
            } catch (e) {
              setErr(errorLabel(e));
            }
          }}
        >
          <input type="text" placeholder="新しいセットの名前" value={name} maxLength={60} autoFocus onChange={(e) => setName(e.target.value)} />
          <button className="primary" disabled={!name.trim()}>
            作成して追加
          </button>
          <button type="button" onClick={() => setAdding(false)}>
            取消
          </button>
          {err && <span className="error small">{err}</span>}
        </form>
      ) : (
        <button className="small" onClick={() => setAdding(true)}>
          ＋ 新しいセット
        </button>
      )}
    </div>
  );
}

const TYPE_LABEL: Record<FieldDef["type"], string> = { text: "テキスト", list: "複数値", date: "日付", number: "数値", boolean: "はい/いいえ" };
const FIELD_ERROR: Record<string, string> = {
  label_required: "表示名を入力してください",
  bad_key: "キーは英小文字で始まる英数字と _（40文字まで）",
  key_taken: "同じキーのフィールドがあります",
  bad_type: "型を選んでください",
  too_many_fields: "フィールドは20個までです",
};

function FieldForm({ initial, onSubmit, onCancel, submitLabel }: { initial?: Partial<FieldDef>; onSubmit: (f: Partial<FieldDef>) => Promise<void>; onCancel?: () => void; submitLabel: string }) {
  const [f, setF] = useState<Partial<FieldDef>>(initial ?? { type: "text", label: "", key: "", description: "" });
  const [err, setErr] = useState<string | null>(null);
  return (
    <form
      className="field-form"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await onSubmit(f);
          setErr(null);
        } catch (e) {
          setErr(FIELD_ERROR[(e as Error).message] ?? (e as Error).message);
        }
      }}
    >
      <input type="text" placeholder="表示名（例：開始日）" value={f.label ?? ""} maxLength={40} onChange={(e) => setF({ ...f, label: e.target.value })} />
      <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value as FieldDef["type"] })}>
        {Object.entries(TYPE_LABEL).map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </select>
      <input type="text" placeholder="キー（例：start_date・省略可）" value={f.key ?? ""} maxLength={40} className="mono" onChange={(e) => setF({ ...f, key: e.target.value })} />
      <input
        type="text"
        className="wide"
        placeholder="AIへの説明（例：展覧会の会期の開始日。会期が書かれていなければ空）"
        value={f.description ?? ""}
        maxLength={500}
        onChange={(e) => setF({ ...f, description: e.target.value })}
      />
      <div className="row">
        <button className="primary" disabled={!f.label?.trim()}>
          {submitLabel}
        </button>
        {onCancel && (
          <button type="button" onClick={onCancel}>
            取消
          </button>
        )}
        {err && <span className="error small">{err}</span>}
      </div>
    </form>
  );
}

function FieldsEditor({ setId, fields, extraction, reload }: { setId: string; fields: FieldDef[]; extraction: { total: number; done: number; errors: number; ai: boolean }; reload: () => Promise<unknown> }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const save = async (path: string, method: string, f: Partial<FieldDef>) => {
    const { id: _id, ...body } = f;
    await api(path, { method, json: { ...body, key: body.key || undefined } });
    setEditing(null);
    void reload();
  };
  const pending = extraction.total - extraction.done - extraction.errors;
  return (
    <div>
      <div className="panel">
        <p className="small muted" style={{ marginTop: 0 }}>
          セット内の item の本文（リンク先から取得した本文を含む）から、生成AIでフィールドの値を取り出して保存します。値は item 一覧での絞り込み・並べ替えに使えます。フィールドを追加・変更すると、セット内の item を取り直します。
        </p>
        {fields.length > 0 && (
          <div className="row small">
            <span>
              抽出済み {extraction.done} / {extraction.total} 件{extraction.errors > 0 && `・失敗 ${extraction.errors} 件`}
              {pending > 0 && `・未抽出 ${pending} 件（5分ごとに少しずつ進みます）`}
            </span>
            <span className="spacer" />
            {extraction.ai ? (
              <button
                disabled={pending + extraction.errors === 0}
                onClick={async () => {
                  await api(`/sets/${setId}/fields/extract`, { method: "POST" });
                  setMsg("抽出を開始しました。しばらくして再読み込みしてください。");
                  setTimeout(() => void reload(), 15000);
                }}
              >
                今すぐ抽出
              </button>
            ) : (
              <span className="error">GEMINI_API_KEY が未設定のため抽出できません</span>
            )}
          </div>
        )}
        {msg && <p className="small">{msg}</p>}
      </div>
      <div className="panel">
        <table className="small">
          <thead>
            <tr>
              <th>表示名</th>
              <th>型</th>
              <th>キー</th>
              <th>AIへの説明</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {fields.map((f) =>
              editing === f.id ? (
                <tr key={f.id}>
                  <td colSpan={5}>
                    <FieldForm initial={f} submitLabel="保存" onCancel={() => setEditing(null)} onSubmit={(v) => save(`/sets/${setId}/fields/${f.id}`, "PATCH", v)} />
                  </td>
                </tr>
              ) : (
                <tr key={f.id}>
                  <td>{f.label}</td>
                  <td>{TYPE_LABEL[f.type]}</td>
                  <td className="mono">{f.key}</td>
                  <td className="muted">{f.description || "—"}</td>
                  <td style={{ whiteSpace: "nowrap" }}>
                    <button onClick={() => setEditing(f.id)}>編集</button>{" "}
                    <button
                      className="danger"
                      onClick={async () => {
                        if (!confirm(`フィールド「${f.label}」と保存済みの値を削除しますか？`)) return;
                        await api(`/sets/${setId}/fields/${f.id}`, { method: "DELETE" });
                        void reload();
                      }}
                    >
                      削除
                    </button>
                  </td>
                </tr>
              ),
            )}
          </tbody>
        </table>
        {fields.length === 0 && <p className="muted small">フィールドはまだありません。例：美術館なら「開始日」「終了日」（日付）、動物園なら「動物」（複数値）。</p>}
        <h3>フィールドを追加</h3>
        <FieldForm key={fields.length} submitLabel="追加" onSubmit={(v) => save(`/sets/${setId}/fields`, "POST", v)} />
      </div>
    </div>
  );
}

const today = () => new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);

/** カスタムフィールドでの絞り込み・並べ替え（f.<key>[.op] / sort） */
function FieldFilters({ setId, fields, value, onChange }: { setId: string; fields: FieldDef[]; value: Record<string, string>; onChange: (v: Record<string, string>) => void }) {
  const [draft, setDraft] = useState(value);
  const set = (k: string, v: string) => setDraft((d) => ({ ...d, [k]: v }));
  const sortable = fields.filter((f) => f.type !== "list");
  const active = Object.values(value).some(Boolean);
  return (
    <form
      className="panel field-filters"
      onSubmit={(e) => {
        e.preventDefault();
        onChange(Object.fromEntries(Object.entries(draft).filter(([, v]) => v)));
      }}
    >
      {fields.map((f) => (
        <label key={f.key} className="field-filter">
          <span className="muted small">{f.label}</span>
          {f.type === "date" || f.type === "number" ? (
            <span className="row">
              <input type={f.type === "date" ? "date" : "number"} value={draft[`f.${f.key}.gte`] ?? ""} onChange={(e) => set(`f.${f.key}.gte`, e.target.value)} title="以上（以降）" />
              〜
              <input type={f.type === "date" ? "date" : "number"} value={draft[`f.${f.key}.lte`] ?? ""} onChange={(e) => set(`f.${f.key}.lte`, e.target.value)} title="以下（以前）" />
            </span>
          ) : f.type === "list" ? (
            <ListValueSelect setId={setId} field={f} value={draft[`f.${f.key}`] ?? ""} onChange={(v) => set(`f.${f.key}`, v)} />
          ) : f.type === "boolean" ? (
            <select value={draft[`f.${f.key}`] ?? ""} onChange={(e) => set(`f.${f.key}`, e.target.value)}>
              <option value="">指定なし</option>
              <option value="true">はい</option>
              <option value="false">いいえ</option>
            </select>
          ) : (
            <input type="text" placeholder="含む" value={draft[`f.${f.key}.contains`] ?? ""} onChange={(e) => set(`f.${f.key}.contains`, e.target.value)} />
          )}
        </label>
      ))}
      {sortable.length > 0 && (
        <label className="field-filter">
          <span className="muted small">並べ替え</span>
          <select value={draft.sort ?? ""} onChange={(e) => set("sort", e.target.value)}>
            <option value="">検出の新しい順</option>
            {sortable.flatMap((f) => [
              <option key={f.key} value={f.key}>
                {f.label}（昇順）
              </option>,
              <option key={`-${f.key}`} value={`-${f.key}`}>
                {f.label}（降順）
              </option>,
            ])}
          </select>
        </label>
      )}
      <div className="row">
        <button className="primary">絞り込む</button>
        {fields.some((f) => f.type === "date") && (
          <button
            type="button"
            title="開始系の日付 ≤ 今日 ≤ 終了系の日付（日付フィールドが2つ以上のとき、先頭を開始・2番目を終了とみなします）"
            onClick={() => {
              const dates = fields.filter((f) => f.type === "date");
              const t = today();
              const next = { ...draft, [`f.${dates[0].key}.lte`]: t, ...(dates[1] ? { [`f.${dates[1].key}.gte`]: t } : {}) };
              setDraft(next);
              onChange(Object.fromEntries(Object.entries(next).filter(([, v]) => v)));
            }}
          >
            今日にあてはまる
          </button>
        )}
        {active && (
          <button
            type="button"
            onClick={() => {
              setDraft({});
              onChange({});
            }}
          >
            条件をクリア
          </button>
        )}
      </div>
    </form>
  );
}

function ListValueSelect({ setId, field, value, onChange }: { setId: string; field: FieldDef; value: string; onChange: (v: string) => void }) {
  const { data } = useApi<{ values: { value: string; count: number }[] }>(`/sets/${setId}/fields/${field.key}/values`);
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">指定なし</option>
      {data?.values.map((v) => (
        <option key={v.value} value={v.value}>
          {v.value}（{v.count}）
        </option>
      ))}
    </select>
  );
}

const PUBLISH_ERROR: Record<string, string> = {
  slug_required: "公開するには URL（スラッグ）が必要です",
  bad_slug: "URL は英小文字・数字・ハイフン（先頭と末尾は英数字）で指定してください",
  slug_taken: "この URL は別のセットで使われています",
};

type SortTab = "now" | "upcoming" | "all";
const TAB_LABEL: Record<SortTab, string> = { now: "開催中", upcoming: "これから", all: "すべて" };
const LAYOUT_CHOICES: [string, string, string][] = [
  ["list", "リスト", "1件ずつ横長に。概要と画像も読める"],
  ["cards", "カード", "画像を大きく、タイル状に並べる"],
  ["compact", "コンパクト", "日付とタイトルだけを1行で"],
  ["table", "表", "フィールドを列にして比べる"],
];

/** セットの公開ページ（radar.wagaya.org/<slug>）の設定 */
type FilterOp = "not_empty" | "empty" | "future" | "past" | "eq" | "ne" | "gte" | "lte" | "true" | "false";
type FilterKind = "date" | "text" | "list" | "number" | "boolean" | "plain";
type Filter = { key: string; op: FilterOp; value?: string | number };
// サーバー側（public.ts の FILTER_OPS）と合わせる
const FILTER_OPS: Record<FilterKind, FilterOp[]> = {
  date: ["not_empty", "empty", "future", "past"],
  text: ["not_empty", "empty", "eq", "ne"],
  list: ["not_empty", "empty", "eq", "ne"],
  number: ["not_empty", "empty", "gte", "lte"],
  boolean: ["not_empty", "empty", "true", "false"],
  plain: ["not_empty", "empty"],
};
const FILTER_OP_LABEL: Record<FilterOp, string> = {
  not_empty: "空ではない",
  empty: "空",
  future: "今日以降",
  past: "今日より前",
  eq: "と一致する",
  ne: "と一致しない",
  gte: "以上",
  lte: "以下",
  true: "はい",
  false: "いいえ",
};

function PublishEditor({ set, fields, reload }: { set: any; fields: FieldDef[]; reload: () => Promise<unknown> }) {
  const opts = (() => {
    try {
      return JSON.parse(set.public_options_json ?? "{}");
    } catch {
      return {};
    }
  })();
  const dates = fields.filter((f) => f.type === "date");
  const facets = fields.filter((f) => f.type === "list" || f.type === "text");
  const [form, setForm] = useState({
    is_public: !!set.is_public,
    slug: set.public_slug ?? "",
    title: set.public_title ?? "",
    description: set.public_description ?? "",
    display: (Array.isArray(opts.display)
      ? opts.display
      : [
          ...(opts.show?.date !== false ? ["date"] : []),
          ...(opts.show?.source !== false ? ["source"] : []),
          "title",
          ...(opts.period && opts.show?.period !== false ? ["period"] : []),
          ...(opts.show?.excerpt !== false ? ["excerpt"] : []),
          ...((opts.fields ?? []) as string[]).filter((k) => k !== opts.period?.start && k !== opts.period?.end).map((k) => `f:${k}`),
        ]) as string[],
    image: opts.show?.image !== false,
    periodStart: opts.period?.start ?? "",
    periodEnd: opts.period?.end ?? "",
    facet: opts.facet ?? "",
    layout: (opts.layout ?? "list") as string,
    excerpt_length: (opts.excerpt_length ?? 140) as number,
    per_page: (opts.per_page ?? 30) as number,
    sort: { now: { key: "period_end", dir: "asc" }, upcoming: { key: "period_start", dir: "asc" }, all: { key: "published", dir: "desc" }, ...(opts.sort ?? {}) } as Record<SortTab, { key: string; dir: string }>,
    default_tab: (opts.default_tab ?? "now") as SortTab,
    filters: (Array.isArray(opts.filters) ? opts.filters : []) as Filter[],
  });
  const hasPeriod = !!(form.periodStart && form.periodEnd);
  const sortKeys: [string, string][] = [
    ["published", "日付"],
    ["first_seen", "収集した日"],
    ["title", "タイトル"],
    ...(hasPeriod ? ([["period_start", "期間の開始"], ["period_end", "期間の終了"]] as [string, string][]) : []),
    ...fields.map((f) => [`f:${f.key}`, f.label] as [string, string]),
  ];
  // 表示できる項目（期間は期間を設定したときだけ）
  const candidates: [string, string][] = [
    ["date", "日付"],
    ["source", "情報源"],
    ["title", "タイトル"],
    ...(hasPeriod ? ([["period", "期間"]] as [string, string][]) : []),
    ["excerpt", "概要"],
    ...fields.map((f) => [`f:${f.key}`, f.label] as [string, string]),
  ];
  const label = new Map(candidates);
  // 絞り込み条件に使える項目と、その種類
  const filterKeys: [string, string, FilterKind][] = [
    ["published", "日付", "date"],
    ["image", "画像", "plain"],
    ["excerpt", "概要", "plain"],
    ...fields.map((f) => [`f:${f.key}`, f.label, f.type as FilterKind] as [string, string, FilterKind]),
  ];
  const kindOf = new Map(filterKeys.map(([k, , t]) => [k, t]));
  const setFilter = (i: number, x: Partial<Filter>) => setForm({ ...form, filters: form.filters.map((f, j) => (j === i ? { ...f, ...x } : f)) });
  const shownItems = form.display.filter((k) => label.has(k));
  const move = (k: string, d: -1 | 1) => {
    const a = [...shownItems];
    const i = a.indexOf(k);
    const j = i + d;
    if (i < 0 || j < 0 || j >= a.length) return;
    [a[i], a[j]] = [a[j], a[i]];
    setForm({ ...form, display: a });
  };
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const base: string = set.public_base_url ?? `${location.origin}/p/`;
  const url = set.public_slug ? `${base}${set.public_slug}` : null;
  return (
    <form
      className="panel publish-form"
      onSubmit={async (e) => {
        e.preventDefault();
        try {
          await api(`/sets/${set.id}/publish`, {
            method: "PUT",
            json: {
              is_public: form.is_public,
              slug: form.slug,
              title: form.title,
              description: form.description,
              options: {
                display: shownItems,
                period: hasPeriod ? { start: form.periodStart, end: form.periodEnd } : null,
                facet: form.facet || null,
                layout: form.layout,
                show: { image: form.image },
                excerpt_length: form.excerpt_length,
                per_page: form.per_page,
                sort: hasPeriod ? form.sort : { all: form.sort.all },
                default_tab: form.default_tab,
                filters: form.filters.filter((f) => kindOf.has(f.key)),
              },
            },
          });
          setErr(null);
          setMsg("保存しました");
          void reload();
        } catch (e) {
          setMsg(null);
          setErr(PUBLISH_ERROR[(e as Error).message] ?? (e as Error).message);
        }
      }}
    >
      <p className="small muted" style={{ marginTop: 0 }}>
        このセットの新着情報を、ログインなしで見られるページとして公開します。表示するのは各情報のタイトル・日付・概要の抜粋・画像・カスタムフィールドで、本文は元のサイトへのリンクで案内します。
      </p>
      <label className="row">
        <input type="checkbox" checked={form.is_public} onChange={(e) => setForm({ ...form, is_public: e.target.checked })} /> 公開する
      </label>
      <div className="kv small">
        <div>URL</div>
        <div className="row">
          <span className="mono muted">{base}</span>
          <input type="text" className="mono" placeholder="kyoto-museums" value={form.slug} maxLength={64} onChange={(e) => setForm({ ...form, slug: e.target.value })} />
        </div>
        <div>ページのタイトル</div>
        <input type="text" placeholder={set.name} value={form.title} maxLength={80} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <div>説明</div>
        <textarea rows={2} placeholder="例：京都の美術館・博物館の展覧会情報をまとめています。" value={form.description} maxLength={400} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <div>期間</div>
        <div className="row">
          {dates.length >= 2 ? (
            <>
              <select value={form.periodStart} onChange={(e) => setForm({ ...form, periodStart: e.target.value })}>
                <option value="">使わない</option>
                {dates.map((f) => (
                  <option key={f.key} value={f.key}>
                    開始：{f.label}
                  </option>
                ))}
              </select>
              <select value={form.periodEnd} onChange={(e) => setForm({ ...form, periodEnd: e.target.value })}>
                <option value="">使わない</option>
                {dates.map((f) => (
                  <option key={f.key} value={f.key}>
                    終了：{f.label}
                  </option>
                ))}
              </select>
              <span className="muted">「開催中 / これから / すべて」のタブを表示します</span>
            </>
          ) : (
            <span className="muted">日付のフィールドが2つ（開始・終了）あると設定できます</span>
          )}
        </div>
        <div>絞り込み</div>
        <div className="row">
          <select value={form.facet} onChange={(e) => setForm({ ...form, facet: e.target.value })}>
            <option value="">使わない</option>
            {facets.map((f) => (
              <option key={f.key} value={f.key}>
                {f.label}
              </option>
            ))}
          </select>
          <span className="muted">値ごとのボタンで絞り込めます（例：動物）</span>
        </div>
        <div>レイアウト</div>
        <div className="layout-choices">
          {LAYOUT_CHOICES.map(([k, label, desc]) => (
            <label key={k} className={`layout-choice${form.layout === k ? " on" : ""}`}>
              <input type="radio" name="layout" checked={form.layout === k} onChange={() => setForm({ ...form, layout: k })} />
              <span className={`layout-thumb layout-${k}`} aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <b>{label}</b>
              <span className="muted">{desc}</span>
            </label>
          ))}
        </div>
        <div>表示する項目</div>
        <div>
          <ol className="display-order">
            {[...shownItems, ...candidates.map(([k]) => k).filter((k) => !shownItems.includes(k))].map((k) => {
              const on = shownItems.includes(k);
              const idx = shownItems.indexOf(k);
              return (
                <li key={k} className={`row${on ? "" : " off"}`}>
                  <label className="row">
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={k === "title"}
                      onChange={(e) => setForm({ ...form, display: e.target.checked ? [...shownItems, k] : shownItems.filter((x) => x !== k) })}
                    />
                    {label.get(k)}
                    {k.startsWith("f:") && <span className="muted">（フィールド）</span>}
                  </label>
                  {k === "excerpt" && on && (
                    <label className="row muted">
                      文字数
                      <input type="number" min={20} max={400} step={10} style={{ width: 72 }} value={form.excerpt_length} onChange={(e) => setForm({ ...form, excerpt_length: Number(e.target.value) })} />
                    </label>
                  )}
                  {on && (
                    <span className="order-btns">
                      <button type="button" className="link small" title="上へ" disabled={idx === 0} onClick={() => move(k, -1)}>
                        ↑
                      </button>
                      <button type="button" className="link small" title="下へ" disabled={idx === shownItems.length - 1} onClick={() => move(k, 1)}>
                        ↓
                      </button>
                    </span>
                  )}
                </li>
              );
            })}
          </ol>
          <label className="row">
            <input type="checkbox" checked={form.image} onChange={(e) => setForm({ ...form, image: e.target.checked })} /> 画像を表示する
            <span className="muted">（リストは右、カードは上。コンパクトと表では出しません）</span>
          </label>
          <span className="muted">上から順に表示します。表では左からの列の順になります。</span>
        </div>
        <div>表示する条件</div>
        <div className="filter-rows">
          {form.filters.map((f, i) => {
            const ops = FILTER_OPS[kindOf.get(f.key) ?? "plain"];
            return (
              <div key={i} className="row">
                <select
                  value={f.key}
                  onChange={(e) => {
                    const k = e.target.value;
                    const o = FILTER_OPS[kindOf.get(k) ?? "plain"];
                    setFilter(i, { key: k, op: o.includes(f.op) ? f.op : o[0], value: undefined });
                  }}
                >
                  {!kindOf.has(f.key) && <option value={f.key}>（削除された項目）</option>}
                  {filterKeys.map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
                <span className="muted">が</span>
                {(f.op === "eq" || f.op === "ne" || f.op === "gte" || f.op === "lte") && (
                  <input
                    type={f.op === "gte" || f.op === "lte" ? "number" : "text"}
                    style={{ width: f.op === "gte" || f.op === "lte" ? 96 : 160 }}
                    value={f.value ?? ""}
                    placeholder="値"
                    onChange={(e) => setFilter(i, { value: e.target.value })}
                  />
                )}
                <select value={f.op} onChange={(e) => setFilter(i, { op: e.target.value as FilterOp })}>
                  {ops.map((o) => (
                    <option key={o} value={o}>
                      {FILTER_OP_LABEL[o]}
                    </option>
                  ))}
                </select>
                <button type="button" className="link small" title="この条件を外す" onClick={() => setForm({ ...form, filters: form.filters.filter((_, j) => j !== i) })}>
                  ✕
                </button>
              </div>
            );
          })}
          <div className="row">
            <button type="button" className="link small" disabled={form.filters.length >= 10} onClick={() => setForm({ ...form, filters: [...form.filters, { key: "published", op: "not_empty" }] })}>
              ＋ 条件を追加
            </button>
            <span className="muted">すべての条件を満たす情報だけを表示します（どのタブにもかかります）</span>
          </div>
        </div>
        <div>並び順</div>
        <div className="sort-rows">
          {(hasPeriod ? (["now", "upcoming", "all"] as SortTab[]) : (["all"] as SortTab[])).map((t) => (
            <div key={t} className="row">
              {hasPeriod && <span className="sort-tab">{TAB_LABEL[t]}</span>}
              <select value={form.sort[t].key} onChange={(e) => setForm({ ...form, sort: { ...form.sort, [t]: { ...form.sort[t], key: e.target.value } } })}>
                {sortKeys.map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
              <select value={form.sort[t].dir} onChange={(e) => setForm({ ...form, sort: { ...form.sort, [t]: { ...form.sort[t], dir: e.target.value } } })}>
                <option value="desc">降順（新しい・大きい順）</option>
                <option value="asc">昇順（古い・小さい順）</option>
              </select>
            </div>
          ))}
          <span className="muted">値のない情報は最後に並びます</span>
        </div>
        {hasPeriod && (
          <>
            <div>最初に開くタブ</div>
            <select value={form.default_tab} onChange={(e) => setForm({ ...form, default_tab: e.target.value as SortTab })}>
              {(["now", "upcoming", "all"] as SortTab[]).map((t) => (
                <option key={t} value={t}>
                  {TAB_LABEL[t]}
                </option>
              ))}
            </select>
          </>
        )}
        <div>1ページの件数</div>
        <div className="row">
          <input type="number" min={10} max={100} step={5} style={{ width: 80 }} value={form.per_page} onChange={(e) => setForm({ ...form, per_page: Number(e.target.value) })} />
          <span className="muted">10〜100 件</span>
        </div>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="primary">保存</button>
        {msg && <span className="small">{msg}</span>}
        {err && <span className="error small">{err}</span>}
        <span className="spacer" />
        {url && set.is_public ? (
          <a href={url} target="_blank" rel="noopener noreferrer">
            公開ページを開く ↗
          </a>
        ) : null}
      </div>
      {url && !set.is_public && set.public_preview_token && (
        <div className="preview-url small">
          <div>
            <b>プレビュー用 URL</b>（非公開のまま、この URL を知っている人だけが見られます）
          </div>
          <div className="row">
            <input type="text" readOnly className="mono" value={`${url}?token=${set.public_preview_token}`} onFocus={(e) => e.currentTarget.select()} />
            <a href={`${url}?token=${set.public_preview_token}`} target="_blank" rel="noopener noreferrer">
              開く ↗
            </a>
            <button
              type="button"
              onClick={async () => {
                if (!confirm("プレビュー用 URL を発行し直しますか？ 今の URL は使えなくなります。")) return;
                await api(`/sets/${set.id}/publish/preview-token`, { method: "POST" });
                void reload();
              }}
            >
              発行し直す
            </button>
          </div>
        </div>
      )}
    </form>
  );
}
