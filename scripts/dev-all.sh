#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT_DIR/scripts/load-ssot-env.sh"

BACKEND_DIR="$ROOT_DIR/$MONOREPO_BACKEND_DIR"
FRONTEND_DIR="$ROOT_DIR/$MONOREPO_FRONTEND_DIR"
BACKEND_PYTHON="$BACKEND_DIR/$MONOREPO_BACKEND_PYTHON"
BACKEND_ENTRYPOINT="$BACKEND_DIR/$MONOREPO_BACKEND_ENTRYPOINT"

check_backend_port() {
  if lsof -nP -iTCP:"$COSYVOICE_API_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[dev] Backend port $COSYVOICE_API_PORT is already in use."
    lsof -nP -iTCP:"$COSYVOICE_API_PORT" -sTCP:LISTEN || true
    echo "[dev] Stop existing process or update COSYVOICE_API_PORT in config/ssot.env"
    exit 1
  fi
}

run_backend() {
  cd "$BACKEND_DIR"
  TOKENIZERS_PARALLELISM="$TOKENIZERS_PARALLELISM" \
  COSYVOICE_API_HOST="$COSYVOICE_API_HOST" \
  COSYVOICE_API_PORT="$COSYVOICE_API_PORT" \
  COSYVOICE_MODEL_DIR="$COSYVOICE_MODEL_DIR" \
  COSYVOICE_API_OUTPUT_DIR="$COSYVOICE_API_OUTPUT_DIR" \
  COSYVOICE_API_HISTORY_SIZE="$COSYVOICE_API_HISTORY_SIZE" \
  COSYVOICE_API_AUDIT_SIZE="$COSYVOICE_API_AUDIT_SIZE" \
  COSYVOICE_API_SUGGESTIONS_PER_FIELD="$COSYVOICE_API_SUGGESTIONS_PER_FIELD" \
  COSYVOICE_API_MAX_UPLOAD_BYTES="$COSYVOICE_API_MAX_UPLOAD_BYTES" \
  COSYVOICE_CORS_ORIGINS="$COSYVOICE_CORS_ORIGINS" \
  "$BACKEND_PYTHON" "$BACKEND_ENTRYPOINT"
}

run_frontend() {
  cd "$FRONTEND_DIR"
  NEXT_PUBLIC_API_BASE="$NEXT_PUBLIC_API_BASE" \
  npm run dev -- --hostname "$FRONTEND_HOST" --port "$FRONTEND_PORT"
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
