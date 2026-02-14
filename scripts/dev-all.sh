#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

run_backend() {
  cd "$ROOT_DIR/CosyVoice"
  if [[ -x ".venv/bin/python" ]]; then
    .venv/bin/python tools/run_api_server.py
  else
    python3 tools/run_api_server.py
  fi
}

run_frontend() {
  cd "$ROOT_DIR/frontend"
  npm run dev
}

cleanup() {
  local pids
  pids=$(jobs -pr || true)
  if [[ -n "$pids" ]]; then
    kill $pids >/dev/null 2>&1 || true
  fi
}

trap cleanup EXIT INT TERM

run_backend &
backend_pid=$!

run_frontend &
frontend_pid=$!

wait -n "$backend_pid" "$frontend_pid"
status=$?

kill "$backend_pid" "$frontend_pid" >/dev/null 2>&1 || true
wait "$backend_pid" "$frontend_pid" >/dev/null 2>&1 || true

exit "$status"
