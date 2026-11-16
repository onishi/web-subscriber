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

/** セットの公開ページ（/p/<slug>）の設定 */
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
    fields: (opts.fields ?? []) as string[],
    periodStart: opts.period?.start ?? "",
    periodEnd: opts.period?.end ?? "",
    facet: opts.facet ?? "",
  });
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const url = set.public_slug ? `${location.origin}/p/${set.public_slug}` : null;
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
              options: { fields: form.fields, period: form.periodStart && form.periodEnd ? { start: form.periodStart, end: form.periodEnd } : null, facet: form.facet || null },
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
          <span className="mono muted">{location.origin}/p/</span>
          <input type="text" className="mono" placeholder="kyoto-museums" value={form.slug} maxLength={64} onChange={(e) => setForm({ ...form, slug: e.target.value })} />
        </div>
        <div>ページのタイトル</div>
        <input type="text" placeholder={set.name} value={form.title} maxLength={80} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <div>説明</div>
        <textarea rows={2} placeholder="例：京都の美術館・博物館の展覧会情報をまとめています。" value={form.description} maxLength={400} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        <div>表示するフィールド</div>
        <div className="row" style={{ flexWrap: "wrap" }}>
          {fields.length === 0 && <span className="muted">カスタムフィールドはありません</span>}
          {fields.map((f) => (
            <label key={f.key} className="row">
              <input
                type="checkbox"
                checked={form.fields.includes(f.key)}
                onChange={(e) => setForm({ ...form, fields: e.target.checked ? [...form.fields, f.key] : form.fields.filter((k) => k !== f.key) })}
              />
              {f.label}
            </label>
          ))}
        </div>
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
      <p className="small muted">
        公開ページは Cloudflare Access の保護対象外にする必要があります（Zero Trust のアプリケーションで、パス <span className="mono">p</span> を Bypass に設定）。
      </p>
    </form>
  );
}
