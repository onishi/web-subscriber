// テスト用 Claude API モック：AIツールループの配線（ツール→VPSプローブ→結果→提出）を検証する。
// モデルの判断品質は検証しない。usage: node scripts/mock-anthropic.mjs <fixtureBase> [port]
import http from "node:http";
const FX = process.argv[2] ?? "http://127.0.0.1:8790";
const port = Number(process.argv[3] ?? 8791);
const requests = [];
const cfg = {
  schema_version: 1,
  source: { url: `${FX}/replace`, kind: "html" },
  fetch: { method: "browser" },
  extract: { items: { container: { css: "ul.news-list" }, select: { css: "ul.news-list > li.news-item" }, fields: {
    title: { from: { css: "a.title" }, required: true }, link: { from: { css: "a.title" }, take: { attr: "href" }, transforms: [{ resolve_url: {} }], required: true },
    published_at: { from: { css: "time" }, take: { attr: "datetime" }, transforms: [{ parse_date: {} }] } } } },
  identity: { method: "link" },
  wait: { initial: { cond: { all: [{ exists: { css: "ul.news-list > li" } }, { stable: { target: { css: ".list-wrap" }, for_ms: 300 } }] }, timeout_ms: 8000 },
          after_paging: { cond: { all: [{ items_changed: {} }, { exists: { css: "ul.news-list > li" } }, { stable: { target: { css: ".list-wrap" }, for_ms: 300 } }] }, timeout_ms: 8000 } },
  paging: { mode: "replace", next: { css: "button.next" } },
};
function turn(n, body) {
  const last = body.messages.at(-1);
  const results = Array.isArray(last.content) ? last.content.filter((b) => b.type === "tool_result") : [];
  const tu = (name, input) => ({ type: "tool_use", id: `toolu_${n}`, name, input });
  if (n === 0) return [{ type: "text", text: "一覧はJSで描画されるので browser 方式で試します。" }, tu("inspect", { url: `${FX}/replace`, method: "browser", selector: { css: "ul.news-list > li" }, wait_ms: 500 })];
  if (n === 1) return [tu("run_extraction", { config: cfg, max_pages: 3, methods: ["browser", "http"] })];
  if (n === 2) return [tu("submit_config", { config: { ...cfg, paging: { mode: "sideways" } }, rationale: "x", unverified: [] })];
  return [tu("submit_config", { config: cfg, rationale: "次へボタンで一覧が置き換わる（replace）。JS描画のため browser。", unverified: ["0件時の表示は未観測"], feed_assessment: "RSSあり。ただしHTML一覧と件数が異なるためHTMLを採用（モック）" })];
}
http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    const body = JSON.parse(b || "{}");
    if (req.url === "/__requests") return res.end(JSON.stringify(requests));
    const n = requests.length;
    const last = body.messages?.at(-1);
    requests.push({ n, tools: body.tools?.map((t) => t.name), last_tool_results: Array.isArray(last?.content) ? last.content.filter((x) => x.type === "tool_result").map((x) => ({ is_error: !!x.is_error, head: String(x.content).slice(0, 160) })) : null });
    const content = turn(n, body);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ id: `msg_${n}`, type: "message", role: "assistant", model: body.model, content, stop_reason: "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }));
  });
}).listen(port, "127.0.0.1", () => console.log(`mock anthropic on ${port}`));
