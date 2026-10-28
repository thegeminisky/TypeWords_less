#!/usr/bin/env bash
# TypeWords 启动脚本（用户级，无需 root）
set -euo pipefail

APP_DIR="/home/agent007/typewords"
cd "$APP_DIR"

export ROOT="$APP_DIR/web"
export DATA_DIR="$APP_DIR/data"
export HOST="0.0.0.0"
export PORT="${PORT:-8300}"
# 门禁密钥，可用环境变量覆盖
export GATE_KEY="${GATE_KEY:-11111111}"
export NODE_ENV=production
export NODE_OPTIONS="--max-old-space-size=256"

exec node "$APP_DIR/server.mjs"
