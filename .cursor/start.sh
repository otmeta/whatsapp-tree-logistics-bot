#!/usr/bin/env bash
set -euo pipefail

ROOT="$(pwd)"

ensure_session() {
  local name="$1"
  local url="$2"
  local cmd="$3"
  if curl -sf "$url" >/dev/null 2>&1; then
    return 0
  fi
  if tmux has-session -t "$name" 2>/dev/null; then
    tmux kill-session -t "$name"
  fi
  tmux new-session -d -s "$name" "cd '$ROOT' && $cmd"
}

ensure_session bot "http://127.0.0.1:3000/health" "env -u PORT npm start >>/tmp/whatsapp-bot.log 2>&1"
ensure_session console-demo "http://127.0.0.1:4100/health" "env -u PORT npm --prefix console run demo >>/tmp/console-demo.log 2>&1"

for _ in $(seq 1 30); do
  if curl -sf http://127.0.0.1:3000/health >/dev/null && curl -sf http://127.0.0.1:4100/health >/dev/null; then
    exit 0
  fi
  sleep 1
done

echo "bot and console demo did not become ready" >&2
echo "--- bot log ---" >&2
tail -n 40 /tmp/whatsapp-bot.log >&2 || true
echo "--- console log ---" >&2
tail -n 40 /tmp/console-demo.log >&2 || true
exit 1
