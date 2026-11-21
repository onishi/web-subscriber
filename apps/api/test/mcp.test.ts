import { describe, expect, it } from "vitest";
import { handleMcp, MCP_TOOL_NAMES } from "../src/mcp";
import { sha256 } from "../src/env";

const TOKEN = "wst_testtoken";
async function env() {
  const hash = await sha256(TOKEN);
  const DB = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => (sql.includes("FROM api_tokens") && args[0] === hash ? { id: "t1", user_id: "u1" } : null),
        run: async () => ({}),
      }),
    }),
  };
  return { DB } as never;
}
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const calls: { method: string; url: string; body: string | null; auth: string | null }[] = [];
const api = async (r: Request) => {
  calls.push({ method: r.method, url: r.url, body: r.method === "GET" ? null : await r.text(), auth: r.headers.get("Authorization") });
  if (r.method === "GET" && r.url.endsWith("/sets/S1"))
    return Response.json({ set: { id: "S1", is_public: 1, public_slug: "kyoto", public_title: "京都", public_description: null, public_options_json: JSON.stringify({ layout: "cards", width: "wide" }), public_base_url: "https://radar.example/", public_preview_token: "pt" } });
  return Response.json({ ok: true, path: new URL(r.url).pathname });
};
const post = async (body: unknown, auth = `Bearer ${TOKEN}`) =>
  handleMcp(new Request("https://reader.example/mcp", { method: "POST", headers: { Authorization: auth, "Content-Type": "application/json" }, body: JSON.stringify(body) }), await env(), ctx, api);

describe("mcp", () => {
  it("rejects missing or bad tokens", async () => {
    expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, "Bearer wst_nope")).status).toBe(401);
  });
  it("initializes and lists tools", async () => {
    const r = await (await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json();
    expect(r.result.protocolVersion).toBe("2025-06-18");
    const t = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
    expect(t.result.tools.map((x: { name: string }) => x.name)).toEqual(MCP_TOOL_NAMES);
    expect(MCP_TOOL_NAMES).toContain("publish_set");
  });
  it("returns 202 for notifications", async () => {
    expect((await post({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
  });
  it("maps tool calls to API requests with the same token", async () => {
    calls.length = 0;
    const r = await (await post({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_items", arguments: { set_id: "S1", unread: true, limit: 5 } } })).json();
    expect(r.result.isError).toBe(false);
    expect(calls[0].url).toBe("https://reader.example/api/v1/items?set_id=S1&unread=1&limit=5");
    expect(calls[0].auth).toBe(`Bearer ${TOKEN}`);
  });
  it("publish_set merges options with the current settings", async () => {
    calls.length = 0;
    const r = await (await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "publish_set", arguments: { set_id: "S1", options: { layout: "calendar" } } } })).json();
    expect(r.result.isError).toBe(false);
    const put = calls.find((c) => c.method === "PUT")!;
    expect(JSON.parse(put.body!)).toEqual({ is_public: true, slug: "kyoto", title: "京都", description: "", options: { layout: "calendar", width: "wide" } });
  });
  it("api_request refuses token management", async () => {
    const r = await (await post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "api_request", arguments: { method: "POST", path: "/tokens" } } })).json();
    expect(r.result.isError).toBe(true);
  });
});
