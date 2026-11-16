import { Link } from "react-router-dom";
import { api, fmtRelative, fmtTime, HEALTH_LABEL, END_LABEL, RUN_LABEL, CHANGE_LABEL } from "../api.js";
import { useState } from "react";
import { useApi } from "../hooks.js";
import { useSets } from "./Sets.js";

export function HealthBadge({ health, detail }: { health: string; detail?: string | null }) {
  const cls = health === "ok" ? "ok" : health === "unknown" ? "" : health === "degraded" ? "warn" : "err";
  return (
    <span className={`badge ${cls}`} title={detail ?? ""}>
      {HEALTH_LABEL[health] ?? health}
    </span>
  );
}

export function methodLabel(kind?: string | null, method?: string | null) {
  if (kind === "feed") return "RSS/Atom";
  if (method === "http") return "HTTP";
  if (method === "browser") return "ブラウザ";
  return "—";
}

export function SubscriptionsPage() {
  const { data, error, reload } = useApi<{ subscriptions: any[] }>("/subscriptions", { pollMs: 15000 });
  const sets = useSets().data?.sets ?? [];
  const setName = new Map(sets.map((s) => [s.id, s.name]));
  const [filter, setFilter] = useState("");
  const subs = (data?.subscriptions ?? []).filter((s) => !filter || (filter === "none" ? !s.set_ids?.length : s.set_ids?.includes(filter)));
  return (
    <div>
      <div className="row">
        <h2>購読先</h2>
        <span className="spacer" />
        {sets.length > 0 && (
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">すべてのセット</option>
            {sets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
            <option value="none">セット未所属</option>
          </select>
        )}
        <Link to="/add" className="btn">
          ＋ 追加
        </Link>
      </div>
      {error && <p className="error">{error}</p>}
      <div className="panel table-wrap">
        <table>
          <thead>
            <tr>
              <th>名前</th>
              <th>方式</th>
              <th>状態</th>
              <th>最終試行</th>
              <th>最終成功</th>
              <th>最終更新検知</th>
              <th>次回予定</th>
              <th>未読</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {subs.map((s) => {
              const [runStatus, change, end] = (s.last_run ?? "||").split("|");
              return (
                <tr key={s.id}>
                  <td>
                    <div className="row">
                      {s.channel_logo && <img className="logo-sm" src={s.channel_logo} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(e) => (e.currentTarget.style.display = "none")} />}
                      <Link to={`/subscriptions/${s.id}`}>{s.display_title || s.channel_title || s.input_url}</Link>
                    </div>
                    <div className="muted small mono">{s.input_url}</div>
                    {s.set_ids?.length > 0 && (
                      <div className="row small">
                        {s.set_ids.map((id: string) => setName.has(id) && (
                          <Link key={id} to={`/sets/${id}`} className="badge">
                            {setName.get(id)}
                          </Link>
                        ))}
                      </div>
                    )}
                  </td>
                  <td>{methodLabel(s.config_kind, s.config_method)}</td>
                  <td>
                    <div className="row">
                      {s.status === "setup" && <span className="badge accent">設定中{s.setup_status === "ready" ? "（確認待ち）" : ""}</span>}
                      {s.status === "paused" && <span className="badge">一時停止</span>}
                      {s.status === "active" && <HealthBadge health={s.health} detail={s.health_detail} />}
                      {s.active_jobs > 0 && <span className="badge accent">実行待ち/中</span>}
                      {s.draft_count > 0 && s.status !== "setup" && <span className="badge warn">修正案あり</span>}
                    </div>
                    {runStatus && (
                      <div className="small muted">
                        前回: {RUN_LABEL[runStatus] ?? runStatus} / {CHANGE_LABEL[change] ?? change} / {END_LABEL[end] ?? end}
                      </div>
                    )}
                  </td>
                  <td className="small">{fmtTime(s.last_attempt_at)}</td>
                  <td className="small">{fmtTime(s.last_success_at)}</td>
                  <td className="small">{fmtTime(s.last_change_at)}</td>
                  <td className="small">{s.status === "active" ? `${fmtTime(s.next_run_at)}（${fmtRelative(s.next_run_at)}）` : "—"}</td>
                  <td>{s.unread_count}</td>
                  <td>
                    <div className="row">
                      {s.status === "active" && (
                        <button
                          disabled={s.active_jobs > 0}
                          onClick={async () => {
                            await api(`/subscriptions/${s.id}/crawl`, { method: "POST" }).catch((e) => alert(e.message));
                            void reload();
                          }}
                        >
                          今すぐ取得
                        </button>
                      )}
                      {(s.status === "active" || s.status === "paused") && (
                        <button
                          onClick={async () => {
                            await api(`/subscriptions/${s.id}`, { method: "PATCH", json: { status: s.status === "active" ? "paused" : "active" } });
                            void reload();
                          }}
                        >
                          {s.status === "active" ? "一時停止" : "再開"}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {data?.subscriptions.length === 0 && <p className="muted">購読先はまだありません。</p>}
      </div>
    </div>
  );
}
