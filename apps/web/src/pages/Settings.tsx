// 設定：MCP / API 用のアクセストークン
import { useState } from "react";
import { api, fmtTime } from "../api.js";
import { useApi } from "../hooks.js";

interface TokenRow {
  id: string;
  name: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
}

export function SettingsPage() {
  const { data, reload } = useApi<{ tokens: TokenRow[]; mcp_url: string }>("/tokens");
  const [name, setName] = useState("");
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const url = data?.mcp_url ?? "";

  const create = async () => {
    setBusy(true);
    try {
      const r = await api<{ name: string; token: string }>("/tokens", { method: "POST", json: { name: name.trim() || "MCP" } });
      setIssued(r);
      setName("");
      await reload();
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (t: TokenRow) => {
    if (!confirm(`トークン「${t.name}」を無効にしますか？ これを使っている AI クライアントは接続できなくなります。`)) return;
    await api(`/tokens/${t.id}`, { method: "DELETE" });
    await reload();
  };

  const cli = issued ? `claude mcp add --transport http web-subscriber ${url} --header "Authorization: Bearer ${issued.token}"` : "";
  const jsonCfg = issued ? JSON.stringify({ mcpServers: { "web-subscriber": { type: "http", url, headers: { Authorization: `Bearer ${issued.token}` } } } }, null, 2) : "";

  return (
    <div className="settings">
      <h2>設定</h2>
      <section className="panel">
        <h3>MCP サーバー（AI から操作）</h3>
        <p className="muted">
          Claude などの AI クライアントから、購読の追加・設定の見直し・セットとカスタムフィールド・公開ページの作成と調整まで、すべての機能を操作できます。接続にはアクセストークンが必要です。
        </p>
        <p>
          サーバーの URL：<code>{url || "…"}</code>
        </p>

        {issued && (
          <div className="token-issued">
            <p>
              <strong>トークン「{issued.name}」を発行しました。</strong>この画面を閉じると二度と表示されないので、今コピーしてください。
            </p>
            <pre className="copyable">{issued.token}</pre>
            <p className="muted">Claude Code に追加するコマンド：</p>
            <pre className="copyable">{cli}</pre>
            <p className="muted">設定ファイル（.mcp.json など）に書く場合：</p>
            <pre className="copyable">{jsonCfg}</pre>
            <button onClick={() => setIssued(null)}>閉じる</button>
          </div>
        )}

        <div className="token-new">
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="名前（例：Claude Code）" maxLength={60} />
          <button className="primary" disabled={busy} onClick={create}>
            トークンを発行
          </button>
        </div>

        {data && data.tokens.length > 0 ? (
          <table className="token-table">
            <thead>
              <tr>
                <th>名前</th>
                <th>先頭</th>
                <th>発行</th>
                <th>最後に使用</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.tokens.map((t) => (
                <tr key={t.id}>
                  <td>{t.name}</td>
                  <td>
                    <code>{t.prefix}…</code>
                  </td>
                  <td>{fmtTime(t.created_at)}</td>
                  <td>{t.last_used_at ? fmtTime(t.last_used_at) : "—"}</td>
                  <td>
                    <button className="danger" onClick={() => revoke(t)}>
                      無効にする
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          data && <p className="muted">発行済みのトークンはありません。</p>
        )}
      </section>
    </div>
  );
}
