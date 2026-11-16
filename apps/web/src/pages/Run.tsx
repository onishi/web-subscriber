import { Link, useParams } from "react-router-dom";
import { fmtTime, RUN_LABEL, CHANGE_LABEL, END_LABEL, TRIGGER_LABEL } from "../api.js";
import { useApi } from "../hooks.js";

export function RunPage() {
  const { id } = useParams();
  const { data } = useApi<any>(`/runs/${id}`, { pollMs: 5000, until: (d) => !!d.run.finished_at });
  if (!data) return <p className="muted">読み込み中…</p>;
  const r = data.run;
  return (
    <div>
      <div className="row">
        <h2>クロール実行</h2>
        <span className="spacer" />
        <Link to={`/subscriptions/${r.subscription_id}`}>購読先へ</Link>
      </div>
      <div className="panel kv small">
        <div>実行ID</div>
        <div className="mono">{r.id}</div>
        <div>種別 / 設定</div>
        <div>
          {TRIGGER_LABEL[r.trigger]} / <Link to={`/configs/${r.config_version_id}`}>設定 v{r.config_version}</Link>
        </div>
        <div>開始 / 終了</div>
        <div>
          {fmtTime(r.started_at)} / {fmtTime(r.finished_at)}
        </div>
        <div>実行状態</div>
        <div>{RUN_LABEL[r.run_status]}</div>
        <div>抽出状態</div>
        <div>{r.extract_status ?? "—"}</div>
        <div>変更状態</div>
        <div>
          {r.change_status ? CHANGE_LABEL[r.change_status] : "—"}
          {!!r.baseline_incomplete && <span className="badge warn">基準データ未完成</span>}
        </div>
        <div>channel変更</div>
        <div>{r.channel_changed ? "あり" : "なし"}</div>
        <div>新規 / 更新 / 確認 / 無効</div>
        <div>
          {r.new_items} / {r.updated_items} / {r.seen_items} / {r.invalid_items}
        </div>
        <div>ページ / 操作</div>
        <div>
          {r.pages_fetched} / {r.actions_performed}
        </div>
        <div>終了理由</div>
        <div>{r.end_reason ? END_LABEL[r.end_reason] ?? r.end_reason : "—"}</div>
        <div>エラー</div>
        <div className="error">{r.error_stage ? `[${r.error_stage}] ${r.error_detail}` : "—"}</div>
        <div>クローラ</div>
        <div className="mono">
          {r.worker_id} {r.crawler_version} {r.engine_version}
        </div>
      </div>
      <div className="panel table-wrap">
        <table className="small">
          <thead>
            <tr>
              <th>#</th>
              <th>種別</th>
              <th>URL</th>
              <th>取得時刻</th>
              <th>HTTP</th>
              <th>操作結果</th>
              <th>抽出</th>
              <th>件数</th>
              <th>エラー・未取得フィールド</th>
              <th>保存物</th>
            </tr>
          </thead>
          <tbody>
            {data.pages.map((p: any) => (
              <tr key={p.seq}>
                <td>{p.seq}</td>
                <td>{p.kind}</td>
                <td className="mono" style={{ maxWidth: 260, overflowWrap: "anywhere" }}>
                  {p.url}
                </td>
                <td>{fmtTime(p.fetched_at)}</td>
                <td title={p.http_status_source === "main_document" ? "主文書のレスポンス" : "URL遷移なし"}>{p.http_status ?? (p.http_status_source === "none" && p.action_result ? "（遷移なし）" : "未取得")}</td>
                <td>{p.action_result ?? ""}</td>
                <td>{p.extract_status}</td>
                <td>
                  {p.item_count}
                  {p.new_unique_items !== null && <span className="muted">（新規キー {p.new_unique_items}）</span>}
                </td>
                <td>
                  <span className="error">{p.error}</span>
                  {p.field_failures &&
                    Object.entries(p.field_failures).map(([k, f]: [string, any]) => (
                      <div key={k} className="muted">
                        {k}: 未一致{f.no_match} 空{f.empty} エラー{f.error}
                      </div>
                    ))}
                  {p.subresource_failures > 0 && <div className="muted">サブリソース失敗 {p.subresource_failures}（主文書とは別）</div>}
                </td>
                <td>
                  {p.snapshot_key && (
                    <a href={`/api/v1/artifacts/${p.snapshot_key}`} target="_blank" rel="noreferrer">
                      HTML
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
