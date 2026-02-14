#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_HOST="${COSYVOICE_API_HOST:-127.0.0.1}"
API_PORT="${COSYVOICE_API_PORT:-8000}"

check_backend_port() {
  if lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[dev] Backend port $API_PORT is already in use."
    lsof -nP -iTCP:"$API_PORT" -sTCP:LISTEN || true
    echo "[dev] Stop existing process or rerun with: COSYVOICE_API_PORT=8001 make dev"
    exit 1
  fi
}

run_backend() {
  cd "$ROOT_DIR/CosyVoice"
  if [[ -x ".venv/bin/python" ]]; then
    COSYVOICE_API_HOST="$API_HOST" COSYVOICE_API_PORT="$API_PORT" .venv/bin/python tools/run_api_server.py
  else
    COSYVOICE_API_HOST="$API_HOST" COSYVOICE_API_PORT="$API_PORT" python3 tools/run_api_server.py
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

check_backend_port

run_backend &
backend_pid=$!

run_frontend &
frontend_pid=$!

wait -n "$backend_pid" "$frontend_pid"
status=$?

kill "$backend_pid" "$frontend_pid" >/dev/null 2>&1 || true
wait "$backend_pid" "$frontend_pid" >/dev/null 2>&1 || true

exit "$status"
