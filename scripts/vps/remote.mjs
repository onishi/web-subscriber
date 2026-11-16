#!/usr/bin/env node
// ローカルから VPS（app ユーザー）へ ssh してクローラをデプロイ・操作する。
//   node scripts/vps/remote.mjs deploy|status|logs|restart [--dry-run]
// 接続先は .env.vps（または環境変数）の WS_VPS_HOST / WS_VPS_USER / WS_VPS_APP_DIR / WS_VPS_BRANCH。
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SERVICE = "web-subscriber-crawler";

export function shellEscape(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function loadEnvFile(path) {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const key = line.slice(0, i).trim();
    const value = line.slice(i + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) process.env[key] = value;
  }
}

export function readConfig() {
  loadEnvFile(`${ROOT}.env.vps`);
  const host = process.env.WS_VPS_HOST;
  if (!host) throw new Error("WS_VPS_HOST is required (.env.vps)");
  return {
    host,
    user: process.env.WS_VPS_USER ?? "app",
    appDir: process.env.WS_VPS_APP_DIR ?? "/home/app/apps/web-subscriber",
    branch: process.env.WS_VPS_BRANCH ?? "main",
  };
}

const PRELUDE = [
  'export NVM_DIR="$HOME/.nvm"',
  'if [ -s "$NVM_DIR/nvm.sh" ]; then . "$NVM_DIR/nvm.sh"; fi',
  // 非対話 ssh でも systemctl --user が使えるように
  'export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
];

export function buildCommand(action, config) {
  const pnpmVersion = JSON.parse(readFileSync(`${ROOT}package.json`, "utf8")).packageManager.split("@")[1];
  const app = shellEscape(config.appDir);
  const unitDir = "$HOME/.config/systemd/user";
  let steps;
  switch (action) {
    case "deploy":
      steps = [
        `cd ${app}`,
        "git fetch origin",
        `git checkout ${shellEscape(config.branch)}`,
        `git pull --ff-only origin ${shellEscape(config.branch)}`,
        `(command -v pnpm >/dev/null || npm install -g pnpm@${pnpmVersion})`,
        // VPS ではクローラとその依存だけ入れる
        "pnpm install --frozen-lockfile --filter @ws/crawler...",
        "pnpm --filter @ws/crawler exec playwright install chromium",
        "pnpm --filter @ws/crawler build",
        `mkdir -p "${unitDir}"`,
        `sed "s|@APP_DIR@|$PWD|g" deploy/${SERVICE}.service > "${unitDir}/${SERVICE}.service"`,
        "systemctl --user daemon-reload",
        `systemctl --user enable ${SERVICE}`,
        `if [ -f .env.crawler ]; then systemctl --user restart ${SERVICE} && sleep 3 && systemctl --user --no-pager status ${SERVICE}; ` +
          `else echo "WARN: ${config.appDir}/.env.crawler がないため起動していません（.env.crawler.example を参照）" >&2; fi`,
      ];
      break;
    case "restart":
      steps = [`systemctl --user restart ${SERVICE}`, "sleep 3", `systemctl --user --no-pager status ${SERVICE}`];
      break;
    case "status":
      steps = [`systemctl --user --no-pager status ${SERVICE}`];
      break;
    case "logs":
      steps = [`journalctl --user -u ${SERVICE} --no-pager -n 200`];
      break;
    default:
      throw new Error(`unknown action: ${action} (deploy|status|logs|restart)`);
  }
  return `bash -lc ${shellEscape([...PRELUDE, ...steps].join(" && "))}`;
}

function main() {
  const args = process.argv.slice(2);
  const action = args.find((a) => !a.startsWith("-")) ?? "deploy";
  const config = readConfig();
  const remote = `${config.user}@${config.host}`;
  const command = buildCommand(action, config);
  process.stdout.write(`${action}: ${remote}:${config.appDir} (${config.branch})\n`);
  if (args.includes("--dry-run")) {
    process.stdout.write(`ssh ${remote} ${command}\n`);
    return;
  }
  const r = spawnSync("ssh", [remote, command], { stdio: "inherit" });
  if (r.error) throw r.error;
  // status は停止中に 3 を返すのでそのまま伝える
  process.exitCode = r.status ?? 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : e}\n`);
    process.exitCode = 1;
  }
}
