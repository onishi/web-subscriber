import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api.js";
import { notifySetsChanged, useSets } from "./Sets.js";

export function AddPage() {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [setIds, setSetIds] = useState<string[]>([]);
  const sets = useSets();
  const nav = useNavigate();
  return (
    <div>
      <h2>購読を追加</h2>
      <div className="panel">
        <p className="muted small">
          RSS/Atom のURLでも、通常のWebページのURLでも登録できます。AIが取得方法と抽出ルールを調べ、VPS上で実際に取得して検証します。結果を確認してから保存してください。
        </p>
        <form
          className="row"
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setErr(null);
            try {
              const r = await api<{ id: string; setup_session_id: string }>("/subscriptions", { method: "POST", json: { url, set_ids: setIds } });
              if (setIds.length) notifySetsChanged();
              nav(`/setup/${r.setup_session_id}`);
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <input type="url" required placeholder="https://example.com/news/" value={url} onChange={(e) => setUrl(e.target.value)} style={{ flex: 1 }} />
          <button className="primary" disabled={busy}>
            調査を開始
          </button>
        </form>
        {sets.data && sets.data.sets.length > 0 && (
          <div className="add-sets">
            <span className="muted small">追加するセット（任意。AI はセットのカスタムフィールドも参考に設定を作ります）</span>
            <div className="row" style={{ flexWrap: "wrap" }}>
              {sets.data.sets.map((s) => (
                <label key={s.id} className="row small">
                  <input
                    type="checkbox"
                    checked={setIds.includes(s.id)}
                    onChange={(e) => setSetIds(e.target.checked ? [...setIds, s.id] : setIds.filter((x) => x !== s.id))}
                  />
                  {s.name}
                </label>
              ))}
            </div>
          </div>
        )}
        {err && <p className="error">{err}</p>}
      </div>
    </div>
  );
}
