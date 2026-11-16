import { useEffect, useState } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { api, fmtDateValue, fmtTime, END_LABEL } from "../api.js";
import { useApi } from "../hooks.js";
import { methodLabel } from "./Subscriptions.js";

const sel = (s: any) => (!s ? "—" : s.css ? `css: ${s.css}` : `xpath: ${s.xpath}`);

function ConfigSummary({ c }: { c: any }) {
  const fields = c.extract?.items?.fields ?? {};
  return (
    <div className="kv small">
      <div>対象URL</div>
      <div className="mono">{c.source.url}</div>
      <div>種類 / 取得方式</div>
      <div>{methodLabel(c.source.kind, c.fetch.method)}</div>
      {c.extract && (
        <>
          <div>一覧（container）</div>
          <div className="mono">{sel(c.extract.items.container)}</div>
          <div>item（繰り返し）</div>
          <div className="mono">{sel(c.extract.items.select)}</div>
          <div>空表示（0件の印）</div>
          <div className="mono">{sel(c.extract.items.empty_marker)}</div>
          <div>フィールド</div>
          <div className="mono">
            {Object.entries(fields).map(([k, v]: [string, any]) => (
              <div key={k}>
                {k}: {v.const !== undefined ? `固定値 ${JSON.stringify(v.const)}` : v.array ? `配列 ${sel(v.array.select)}` : v.object ? "オブジェクト" : `${sel(v.from)} → ${typeof v.take === "object" ? `@${v.take.attr}` : v.take ?? "text"}`}
                {v.required ? "（必須）" : ""}
                {v.fallback ? `（代替 ${v.fallback.length}）` : ""}
              </div>
            ))}
          </div>
        </>
      )}
      <div>識別方法</div>
      <div>
        {c.identity.method}
        {c.identity.fields?.length ? ` (${c.identity.fields.join(", ")})` : ""}
      </div>
      <div>ページング</div>
      <div>
        {c.paging.mode === "none" ? "なし" : `${c.paging.mode}：${sel(c.paging.next)}（最大 ${c.paging.limits.max_pages} ページ）`}
      </div>
      <div>初期待機</div>
      <div className="mono">{c.wait?.initial ? `${JSON.stringify(c.wait.initial.cond)}（${c.wait.initial.timeout_ms}ms）` : "—"}</div>
      <div>操作後待機</div>
      <div className="mono">{c.wait?.after_paging ? `${JSON.stringify(c.wait.after_paging.cond)}（${c.wait.after_paging.timeout_ms}ms）` : "—"}</div>
      <div>robots.txt</div>
      <div>{c.politeness.respect_robots_txt ? "従う" : "従わない"}</div>
    </div>
  );
}

function ValidationResult({ v, title }: { v: any; title: string }) {
  if (!v) return null;
  if (v.error) return <p className="error">{title}: {v.error}</p>;
  return (
    <div>
      <h3>
        {title}：{v.item_count}件 / {v.outcome.extract_status} / {END_LABEL[v.outcome.end_reason] ?? v.outcome.end_reason}
        {v.outcome.error_detail && <span className="error small"> {v.outcome.error_detail}</span>}
      </h3>
      <div className="table-wrap">
        <table className="small">
          <thead>
            <tr>
              <th>#</th>
              <th>種別</th>
              <th>HTTP</th>
              <th>抽出</th>
              <th>件数</th>
              <th>エラー / 未取得フィールド</th>
            </tr>
          </thead>
          <tbody>
            {v.pages.map((p: any) => (
              <tr key={p.seq}>
                <td>{p.seq}</td>
                <td>{p.kind}</td>
                <td>{p.http_status ?? (p.http_status_source === "none" ? "（遷移なし）" : "未取得")}</td>
                <td>{p.extract_status}</td>
                <td>{p.item_count}</td>
                <td>
                  {p.error}
                  {p.field_failures &&
                    Object.entries(p.field_failures).map(([k, f]: [string, any]) => (
                      <div key={k} className="muted">
                        {k}: 未一致{f.no_match} 空{f.empty} エラー{f.error} {f.reasons?.join(", ")}
                      </div>
                    ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h3>抽出結果プレビュー（先頭 {Math.min(v.items.length, 40)} 件）</h3>
      <div className="table-wrap">
        <table className="small">
          <thead>
            <tr>
              <th>タイトル</th>
              <th>リンク</th>
              <th>公開日時</th>
              <th>その他</th>
            </tr>
          </thead>
          <tbody>
            {v.items.map((it: any, i: number) => (
              <tr key={i} style={it.valid ? undefined : { opacity: 0.6 }}>
                <td>
                  {!it.valid && <span className="badge err">無効</span>} {it.title}
                </td>
                <td className="mono" style={{ maxWidth: 280, overflowWrap: "anywhere" }}>
                  {it.link}
                </td>
                <td>{fmtDateValue(it.published_at)}</td>
                <td className="muted">
                  {it.categories?.map((c: any) => c.term).join(", ")}
                  {it.extracted && Object.keys(it.extracted).length > 0 && <span className="mono"> {JSON.stringify(it.extracted).slice(0, 120)}</span>}
                  {it.failures?.length > 0 && <div className="error">{it.failures.map((f: any) => `${f.field}:${f.status}`).join(" ")}</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function ConfigReview({ cvId }: { cvId: string }) {
  const { data, reload } = useApi<any>(`/configs/${cvId}`);
  const [text, setText] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [probeId, setProbeId] = useState<string | null>(null);
  const nav = useNavigate();
  useEffect(() => {
    if (data?.config) setText(JSON.stringify(data.config, null, 2));
  }, [data?.id]);
  if (!data) return <p className="muted">読み込み中…</p>;
  const report = data.report;
  const edited = text !== JSON.stringify(data.config, null, 2);

  return (
    <div>
      <div className="panel">
        <div className="row">
          <h3 style={{ margin: 0 }}>
            設定 v{data.version} <span className="badge">{data.state}</span> <span className="badge">{data.origin}</span>
          </h3>
          <span className="spacer" />
          {data.state === "draft" && (
            <>
              <button
                className="primary"
                disabled={edited}
                title={edited ? "編集内容を新しい版として保存してから有効化してください" : ""}
                onClick={async () => {
                  const r = await api<any>(`/configs/${cvId}/activate`, { method: "POST" });
                  setMsg(r.run ? "有効化しました。初回取得を開始します。" : "有効化しました。");
                  void reload();
                  nav(`/subscriptions/${data.subscription_id}`);
                }}
              >
                この設定で保存・開始
              </button>
              <button
                className="danger"
                onClick={async () => {
                  await api(`/configs/${cvId}/reject`, { method: "POST" });
                  void reload();
                }}
              >
                破棄
              </button>
            </>
          )}
        </div>
        {data.note && <p className="small">{data.note}</p>}
        {msg && <p className="small">{msg}</p>}
        <ConfigSummary c={data.config} />
      </div>

      {report && (
        <div className="panel">
          <h3 style={{ marginTop: 0 }}>検証結果（{fmtTime(report.created_at)}）</h3>
          {report.feed_assessment && <p className="small">RSS/Atom: {report.feed_assessment}</p>}
          <ul className="small">
            {report.checks.map((c: any) => (
              <li key={c.name} className={c.ok ? "check-ok" : "check-ng"}>
                {c.name}: {c.detail}
              </li>
            ))}
          </ul>
          {report.comparison && (
            <p className="small">
              既存itemとの照合：候補 {report.comparison.candidate_items} 件中 {report.comparison.matched_existing} 件が既存と一致、{report.comparison.would_be_new} 件は新規扱い
            </p>
          )}
          <h3>未検証事項</h3>
          {report.unverified.length ? (
            <ul className="small">
              {report.unverified.map((u: string, i: number) => (
                <li key={i}>{u}</li>
              ))}
            </ul>
          ) : (
            <p className="small muted">なし</p>
          )}
          <ValidationResult v={report.validation.primary} title={`採用方式（${report.method}）`} />
          {report.validation.secondary && !report.validation.secondary.error && (
            <details>
              <summary className="small">比較：もう一方の方式（{report.validation.secondary.item_count}件）</summary>
              <ValidationResult v={report.validation.secondary} title="比較方式" />
            </details>
          )}
        </div>
      )}

      <div className="panel">
        <div className="row">
          <h3 style={{ margin: 0 }}>設定の確認・手動編集（JSON）</h3>
          <span className="spacer" />
          <button
            onClick={async () => {
              setProbeId((await api<any>(`/configs/${cvId}/validate`, { method: "POST" })).probe_id);
            }}
          >
            この版をVPSで検証
          </button>
          <button
            disabled={!edited}
            onClick={async () => {
              setMsg(null);
              let cfg;
              try {
                cfg = JSON.parse(text);
              } catch (e) {
                return setMsg(`JSONエラー: ${(e as Error).message}`);
              }
              try {
                const r = await api<any>(`/subscriptions/${data.subscription_id}/configs`, { method: "POST", json: { config: cfg, note: "手動編集" } });
                nav(`/configs/${r.id}`);
              } catch (e) {
                setMsg(((e as any).data?.errors ?? [(e as Error).message]).join("\n"));
              }
            }}
          >
            新しい版として保存
          </button>
        </div>
        {msg && <pre className="error">{msg}</pre>}
        <textarea value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      </div>
      {probeId && <ProbeView id={probeId} method={data.config.fetch.method} />}
    </div>
  );
}

function ProbeView({ id, method }: { id: string; method: string }) {
  const { data } = useApi<any>(`/probes/${id}`, { pollMs: 2000, until: (d) => d.status === "ok" || d.status === "error" });
  if (!data || data.status === "queued" || data.status === "running") return <div className="panel muted">VPSで検証中…（{data?.status ?? "queued"}）</div>;
  if (data.status === "error") return <div className="panel error">検証失敗: {data.error}</div>;
  const s = data.summary ?? {};
  return (
    <div className="panel">
      <h3 style={{ marginTop: 0 }}>検証結果</h3>
      {data.comparison && (
        <p className="small">
          現在の保存データとの照合：{data.comparison.candidate_items} 件中 {data.comparison.matched_existing} 件が既存 item と一致、{data.comparison.would_be_new} 件は新規扱い（既存 {data.comparison.existing_items} 件）
        </p>
      )}
      <ValidationResult v={s[method]} title={`方式 ${method}`} />
      {Object.keys(s)
        .filter((m) => m !== method)
        .map((m) => (
          <details key={m}>
            <summary className="small">比較：{m}（{s[m]?.item_count ?? "-"}件）</summary>
            <ValidationResult v={s[m]} title={m} />
          </details>
        ))}
    </div>
  );
}

export function ConfigPage() {
  const { id } = useParams();
  const { data } = useApi<any>(`/configs/${id}`);
  return (
    <div>
      <div className="row">
        <h2>設定バージョン</h2>
        <span className="spacer" />
        {data && <Link to={`/subscriptions/${data.subscription_id}`}>購読先へ</Link>}
      </div>
      <ConfigReview key={id} cvId={id!} />
    </div>
  );
}
