// クローラ用トークンを発行して D1 に登録する（トークン本体は表示のみ・DBにはハッシュを保存）
// usage: node scripts/create-worker-token.mjs <name> [--local|--remote]
import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const name = process.argv[2] ?? "vps";
const where = process.argv.includes("--remote") ? "--remote" : "--local";
const token = randomBytes(32).toString("hex");
const hash = createHash("sha256").update(token).digest("hex");
const sql = `INSERT INTO crawler_workers (id, name, token_hash, scopes, created_at) VALUES ('${randomUUID()}', '${name.replace(/'/g, "")}', '${hash}', 'jobs:lease,runs:write,probes:write', '${new Date().toISOString()}')`;
execFileSync("npx", ["wrangler", "d1", "execute", "web-subscriber-db-apac", where, "--command", sql], { stdio: ["ignore", "ignore", "inherit"] });
console.log(token);
