#!/bin/bash
# VPS 上でクローラを起動する（systemd ユーザーユニットから呼ばれる）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

if [ -f "$APP_DIR/.env.crawler" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$APP_DIR/.env.crawler"
  set +a
fi

: "${WS_API_BASE:?WS_API_BASE is required (.env.crawler)}"
: "${WS_WORKER_TOKEN:?WS_WORKER_TOKEN is required (.env.crawler)}"

cd "$APP_DIR/apps/crawler"
exec node dist/main.js
