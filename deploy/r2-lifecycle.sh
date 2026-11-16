#!/usr/bin/env bash
# R2 の保存期間（docs/design.md §6.6）
#   r30/    : HTML・DOM・スクリーンショット・プローブ結果 30日
#   r90/    : フィード生XML 90日
#   latest/ : 成功時の最新スナップショット（期限なし・上書き）
#   sessions/ : AI セッションの記録・検証レポート（期限なし）
set -euo pipefail
BUCKET="${1:-web-subscriber-blobs}"
cd "$(dirname "$0")/../apps/api"
npx wrangler r2 bucket lifecycle add "$BUCKET" expire-r30 r30/ --expire-days 30 --force
npx wrangler r2 bucket lifecycle add "$BUCKET" expire-r90 r90/ --expire-days 90 --force
