#!/usr/bin/env bash
# TypeWords 启动脚本（用户级，无需 root）
# 注意：不用 pipefail——服务器 tmux/cron 环境可能以 dash 语义执行，会报 invalid option name
set -eu

APP_DIR="/home/agent007/typewords"
cd "$APP_DIR"

export ROOT="$APP_DIR/web"
export DATA_DIR="$APP_DIR/data"
export HOST="0.0.0.0"
export PORT="${PORT:-8300}"
export NODE_ENV=production
export NODE_OPTIONS="--max-old-space-size=512"

# 日志轮转：超过 10MB 归档，最多保留 5 份
LOG="$APP_DIR/logs/server.log"
if [ -f "$LOG" ] && [ "$(stat -c%s "$LOG" 2>/dev/null || echo 0)" -gt 10485760 ]; then
  mv "$LOG" "$LOG.$(date +%Y%m%d%H%M%S).old"
  ls -1t "$LOG".*.old 2>/dev/null | tail -n +6 | xargs -r rm -f
fi

exec node "$APP_DIR/server.mjs"
