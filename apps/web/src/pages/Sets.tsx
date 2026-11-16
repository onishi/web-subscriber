// セット：複数の購読先をまとめて名前を付けたもの（例「京都の美術館」）
import { useEffect, useState } from "react";
import { Link, NavLink, useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { useApi } from "../hooks.js";
import { ItemList } from "./Items.js";

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
  const [tab, setTab] = useState<"items" | "members">("items");
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
      </div>
      {tab === "items" &&
        (data.members.length ? (
          <ItemList key={set.id} setId={set.id} />
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
