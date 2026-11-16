# web-subscriber

RSS/Atom と通常の Web ページを購読する Web アプリ（仮称 Web Subscriber）。
URL を登録すると AI が取得方法と抽出ルールを提案し、VPS 上で実際に取得して検証します。保存後の定期クロールは AI を呼ばず、保存済みの宣言的ルールを機械的に実行します。

- 設計書: [docs/design.md](docs/design.md)

## 構成

| ディレクトリ | 役割 | 実行場所 |
|---|---|---|
| `apps/api` | API（Hono）・D1・R2・Cron・Workflows（AI設定/修正提案）・静的配信 | Cloudflare Workers |
| `apps/web` | Web 画面（React + Vite） | Workers Static Assets |
| `apps/crawler` | ジョブ取得・HTTP/ブラウザ取得・待機・ページング・抽出・結果送信 | さくらVPS（Node.js + Playwright/Chromium） |
| `packages/shared` | 共通モデル・設定スキーマ(zod)・抽出DSL評価器・日付解析・識別キー/ハッシュ・判定ロジック | 全体で共有 |
| `packages/fixtures` | 検証用フィクスチャサイト（RSS/Atom、JS描画、replace/append、0件、破損、エラー） | テスト |

対象サイトへのアクセスはすべて VPS から行います（AI の調査・プレビューも同じ取得機構）。

## ローカル開発

前提：Node.js 22、pnpm 10、Chromium（`npx playwright install chromium`）。

```bash
pnpm install
```

```bash
pnpm --filter @ws/web build
```

```bash
cd apps/api && printf 'DEV_AUTH_BYPASS=1\n' > .dev.vars && npx wrangler d1 migrations apply web-subscriber-db --local
```

```bash
cd apps/api && node scripts/create-worker-token.mjs local-vps --local
```

```bash
cd apps/api && npx wrangler dev --local --port 8787
```

```bash
PORT=8790 node packages/fixtures/src/server.mjs
```

```bash
cd apps/crawler && pnpm build && WS_WORKER_TOKEN=<発行したトークン> WS_ALLOW_PRIVATE_HOSTS=1 node dist/main.js
```

http://127.0.0.1:8787 を開くと画面が使えます。`GEMINI_API_KEY` を `.dev.vars` に入れると AI（Gemini）による提案が有効になります（未設定時は RSS/Atom 検出と繰り返し構造による自動判定で提案）。

### テスト

```bash
pnpm --filter @ws/shared test
```

```bash
pnpm --filter @ws/crawler test
```

E2E（上記の wrangler dev・フィクスチャ・クローラが起動している状態で）：VPSクローラ → API → D1/R2 → 閲覧API までを接続して検証します。

```bash
WS_WORKER_TOKEN=<トークン> node scripts/e2e.mjs
```

AI ツールループの配線（ツール呼び出し → VPS プローブ → 結果 → 提出・スキーマ検証）は、`scripts/mock-gemini.mjs` を起動し、`.dev.vars` に `GEMINI_API_KEY=dummy` と `GEMINI_BASE_URL=http://127.0.0.1:8791` を設定して確認できます（モデルの判断品質は検証しません）。

## デプロイ

### Cloudflare

```bash
cd apps/api && npx wrangler d1 create web-subscriber-db
```

出力された `database_id` を `apps/api/wrangler.jsonc` に設定します。

```bash
cd apps/api && npx wrangler r2 bucket create web-subscriber-blobs && npx wrangler d1 migrations apply web-subscriber-db --remote
```

```bash
./deploy/r2-lifecycle.sh web-subscriber-blobs
```

```bash
cd apps/api && npx wrangler secret put GEMINI_API_KEY
```

```bash
pnpm --filter @ws/web build && cd apps/api && npx wrangler deploy
```

```bash
cd apps/api && node scripts/create-worker-token.mjs sakura-vps --remote
```

利用者認証は Cloudflare Access を使います。Zero Trust でこの Worker のホスト名に Access アプリケーションを作成し（本人のメールのみ許可）、`/worker/*` はバイパス（クローラはトークン認証）にします。`wrangler.jsonc` の `ACCESS_TEAM_DOMAIN`（例 `https://<team>.cloudflareaccess.com`）と `ACCESS_AUD`（アプリケーションの AUD）を設定してください。

### さくらVPS

クローラは `app` ユーザーの systemd ユーザーユニットとして常駐させます（cinema-timetable と同じ `app` ユーザー・nvm の Node を使い、デプロイに sudo は不要）。

初回のみ（VPS 上、root 権限が必要な作業）：ログアウト後もユーザーユニットを動かすための linger と、Chromium の依存パッケージ。

```bash
sudo loginctl enable-linger app
```

初回のみ（VPS 上、`app` ユーザーで）：clone して依存パッケージを入れます（Node.js 22 以上を nvm で用意）。

```bash
git clone https://github.com/onishi/web-subscriber /home/app/apps/web-subscriber && cd /home/app/apps/web-subscriber && corepack pnpm install --frozen-lockfile --filter @ws/crawler...
```

```bash
cd /home/app/apps/web-subscriber/apps/crawler && sudo env PATH="$PATH" npx playwright install-deps chromium
```

`.env.crawler.example` を `/home/app/apps/web-subscriber/.env.crawler` にコピーして値を設定します（`WS_WORKER_TOKEN` は上の `create-worker-token.mjs sakura-vps --remote` で発行したもの）。

ローカルで `.env.vps.example` を `.env.vps` にコピーして `WS_VPS_HOST` を設定したら、以降のデプロイはローカルから：

```bash
pnpm vps:deploy
```

`git pull` → クローラ依存のみ `pnpm install` → `playwright install chromium` → ビルド → `deploy/web-subscriber-crawler.service` を `~/.config/systemd/user/` に配置 → 再起動、までを ssh 越しに行います。`--dry-run` を付けると実行するコマンドを表示するだけになります。

```bash
pnpm vps:status
```

```bash
pnpm vps:logs
```

```bash
pnpm vps:restart
```

User-Agent は `Web-Subscriber/0.0.1 (+<WS_CONTACT_URL>)`（browser 方式では Chromium の UA に付加）。robots.txt には `Web-Subscriber` トークンで従います。
