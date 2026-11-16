import { useParams, Link } from "react-router-dom";
import { fmtTime } from "../api.js";
import { useApi } from "../hooks.js";
import { ConfigReview } from "./Config.js";

const STEP_LABEL: Record<string, string> = { discover: "調査（HTTP / ブラウザ取得）", propose: "取得方法・抽出ルールの提案", validate: "VPSでの検証", error: "エラー", trigger: "起動理由" };

export function SetupPage() {
  const { id } = useParams();
  const { data, error } = useApi<any>(`/setup-sessions/${id}`, { pollMs: 2500, until: (d) => d.status !== "running" });
  if (error) return <p className="error">{error}</p>;
  if (!data) return <p className="muted">読み込み中…</p>;
  return (
    <div>
      <div className="row">
        <h2>{data.kind === "repair" ? "修正提案" : "AIによる設定生成"}</h2>
        <span className="spacer" />
        <Link to={`/subscriptions/${data.subscription_id}`}>購読先へ</Link>
      </div>
      <div className="panel">
        <div className="row small">
          <span className={`badge ${data.status === "ready" ? "ok" : data.status === "failed" ? "err" : "accent"}`}>{data.status === "running" ? "実行中" : data.status === "ready" ? "確認待ち" : "失敗"}</span>
          <span className="muted">開始 {fmtTime(data.created_at)}</span>
        </div>
        <ul className="progress small">
          {data.progress.map((p: any, i: number) => (
            <li key={i}>
              <span className={p.status === "done" ? "check-ok" : p.status === "error" ? "check-ng" : ""}>
                {p.status === "running" ? "⏳ " : p.status === "info" ? "・ " : ""}
                <b>{STEP_LABEL[p.step] ?? (p.step.startsWith("ai-") ? "AI" : p.step)}</b> {p.detail}
              </span>{" "}
              <span className="muted">{fmtTime(p.at)}</span>
            </li>
          ))}
        </ul>
        {data.error && <p className="error">{data.error}</p>}
      </div>
      {data.status === "ready" && data.config_version && <ConfigReview cvId={data.config_version.id} />}
    </div>
  );
}
