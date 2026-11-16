import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, fmtRelative, fmtTime, RUN_LABEL, CHANGE_LABEL, END_LABEL, TRIGGER_LABEL } from "../api.js";
import { useApi } from "../hooks.js";
import { HealthBadge, methodLabel } from "./Subscriptions.js";
import { ItemList } from "./Items.js";

export function RunsTable({ subId }: { subId: string }) {
  const { data } = useApi<{ runs: any[] }>(`/subscriptions/${subId}/runs`, { pollMs: 10000 });
  return (
    <div className="table-wrap">
      <table className="small">
        <thead>
          <tr>
            <th>開始</th>
            <th>種別</th>
            <th>設定</th>
            <th>実行状態</th>
            <th>HTTP</th>
            <th>抽出</th>
            <th>変更</th>
            <th>新規/更新/確認</th>
            <th>ページ/操作</th>
            <th>終了理由</th>
            <th>エラー</th>
          </tr>
        </thead>
        <tbody>
          {data?.runs.map((r) => (
            <tr key={r.id}>
              <td>
                <Link to={`/runs/${r.id}`}>{fmtTime(r.started_at ?? r.queued_at)}</Link>
              </td>
              <td>{TRIGGER_LABEL[r.trigger] ?? r.trigger}</td>
              <td>v{r.config_version}</td>
              <td>
                <span className={`badge ${r.run_status === "completed" ? "ok" : r.run_status === "failed" ? "err" : r.run_status === "partial" ? "warn" : ""}`}>{RUN_LABEL[r.run_status] ?? r.run_status}</span>
              </td>
              <td>{r.first_http_status ?? (r.finished_at ? "未取得" : "")}</td>
              <td>{r.extract_status ?? ""}</td>
              <td>
                {r.change_status && <span className={`badge ${r.change_status === "changed" ? "accent" : r.change_status === "unknown" ? "warn" : ""}`}>{CHANGE_LABEL[r.change_status]}</span>}
                {!!r.baseline_incomplete && <div className="warn small">基準データ未完成</div>}
                {!!r.rebaseline && <div className="muted small">再基準化</div>}
              </td>
              <td>
                {r.new_items}/{r.updated_items}/{r.seen_items}
              </td>
              <td>
                {r.pages_fetched}/{r.actions_performed}
              </td>
              <td>{r.end_reason ? END_LABEL[r.end_reason] ?? r.end_reason : ""}</td>
              <td className="error">{r.error_stage ? `[${r.error_stage}] ${r.error_detail ?? ""}` : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function SubscriptionPage() {
  const { id } = useParams();
  const { data, reload } = useApi<any>(`/subscriptions/${id}`, { pollMs: 10000 });
  const [tab, setTab] = useState("items");
  if (!data) return <p className="muted">読み込み中…</p>;
  const s = data.subscription;
  const cfg = data.active_config?.config;
  const drafts = data.versions.filter((v: any) => v.state === "draft");
  return (
    <div>
      <div className="row">
        <h2>{s.display_title || data.channel?.title?.value || s.input_url}</h2>
        <span className="spacer" />
        {s.status === "active" && (
          <button
            disabled={!!data.active_job}
            onClick={async () => {
              await api(`/subscriptions/${s.id}/crawl`, { method: "POST" }).catch((e) => alert(e.message));
              void reload();
            }}
          >
            {data.active_job ? "実行待ち/中…" : "今すぐ取得"}
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
        <button
          onClick={async () => {
            try {
              const r = await api<any>(`/subscriptions/${s.id}/repair`, { method: "POST" });
              location.href = `/setup/${r.setup_session_id}`;
            } catch (e) {
              alert((e as Error).message);
            }
          }}
        >
          AIで設定を見直す
        </button>
      </div>
      <div className="panel">
        <div className="kv small">
          <div>URL</div>
          <div className="mono">{s.input_url}</div>
          <div>状態</div>
          <div className="row">
            <span className="badge">{s.status === "active" ? "稼働中" : s.status === "paused" ? "一時停止" : s.status === "setup" ? "設定中" : s.status}</span>
            {s.status !== "setup" && <HealthBadge health={s.health} detail={s.health_detail} />}
            {s.health_detail && <span className="muted">{s.health_detail}</span>}
          </div>
          <div>現在の取得方式</div>
          <div>{cfg ? `${methodLabel(cfg.source.kind, cfg.fetch.method)}（設定 v${data.active_config.version}）` : "未設定"}</div>
          <div>最終試行</div>
          <div>{fmtTime(s.last_attempt_at)}</div>
          <div>最終成功</div>
          <div>{fmtTime(s.last_success_at)}</div>
          <div>最終更新検知</div>
          <div>{fmtTime(s.last_change_at)}</div>
          <div>次回予定</div>
          <div>{s.status === "active" ? `${fmtTime(s.next_run_at)}（${fmtRelative(s.next_run_at)}）` : "—"}</div>
          <div>item 画像</div>
          <div className="row">
            <select
              value={s.item_image_mode ?? ""}
              onChange={async (e) => {
                await api(`/subscriptions/${s.id}`, { method: "PATCH", json: { item_image_mode: e.target.value || null } });
                void reload();
              }}
            >
              <option value="">自動判定（次回の取得で試行）</option>
              <option value="og_image">リンク先の og:image を取得する</option>
              <option value="off">取得しない</option>
            </select>
            <span className="muted">配信元に画像の指定がない item だけ、リンク先を確認します</span>
          </div>
          <div>基準データ</div>
          <div>{s.baseline_status === "complete" ? "作成済み" : s.baseline_status === "partial" ? "未完成（初回巡回が途中で終了）" : "未作成"}</div>
        </div>
        {data.current_session && data.current_session.status !== "failed" && data.current_session.status !== "done" && (
          <p className="small">
            {data.current_session.kind === "repair" ? "修正提案" : "AI設定"}：<Link to={`/setup/${data.current_session.id}`}>{data.current_session.status === "running" ? "実行中" : "結果を確認"}</Link>
          </p>
        )}
        {drafts.length > 0 && (
          <p className="small">
            <span className="badge warn">未適用の設定案</span>{" "}
            {drafts.map((v: any) => (
              <Link key={v.id} to={`/configs/${v.id}`} style={{ marginRight: 8 }}>
                v{v.version}（{v.origin}）
              </Link>
            ))}
            稼働中の設定は自動では変更されません。
          </p>
        )}
      </div>
      <div className="tabs">
        {[
          ["items", "item"],
          ["runs", "クロール履歴"],
          ["config", "設定"],
        ].map(([k, l]) => (
          <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
            {l}
          </button>
        ))}
      </div>
      {tab === "items" && <ItemList subscriptionId={s.id} showViewTabs />}
      {tab === "runs" && <RunsTable subId={s.id} />}
      {tab === "config" && (
        <div className="panel table-wrap">
          <table className="small">
            <thead>
              <tr>
                <th>版</th>
                <th>状態</th>
                <th>作成元</th>
                <th>作成</th>
                <th>有効化</th>
                <th>メモ</th>
              </tr>
            </thead>
            <tbody>
              {data.versions.map((v: any) => (
                <tr key={v.id}>
                  <td>
                    <Link to={`/configs/${v.id}`}>v{v.version}</Link>
                  </td>
                  <td>
                    <span className={`badge ${v.state === "active" ? "ok" : v.state === "draft" ? "warn" : ""}`}>{v.state}</span>
                  </td>
                  <td>{v.origin}</td>
                  <td>{fmtTime(v.created_at)}</td>
                  <td>{fmtTime(v.activated_at)}</td>
                  <td className="muted">{(v.note ?? "").slice(0, 120)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
