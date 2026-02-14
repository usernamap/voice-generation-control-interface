#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SSOT_ENV_FILE="${SSOT_ENV_FILE:-$ROOT_DIR/config/ssot.env}"

if [[ ! -f "$SSOT_ENV_FILE" ]]; then
  echo "[ssot] Missing configuration file: $SSOT_ENV_FILE" >&2
  exit 1
fi

# shellcheck disable=SC1090
set -a
source "$SSOT_ENV_FILE"
set +a

required_keys=(
  MONOREPO_BACKEND_DIR
  MONOREPO_FRONTEND_DIR
  MONOREPO_BACKEND_PYTHON
  MONOREPO_BACKEND_ENTRYPOINT
  MONOREPO_BACKEND_REQUIREMENTS
  COSYVOICE_API_HOST
  COSYVOICE_API_PORT
  FRONTEND_HOST
  FRONTEND_PORT
  NEXT_PUBLIC_API_BASE
  COSYVOICE_WEBUI_HOST
  COSYVOICE_WEBUI_PORT
  COSYVOICE_CORS_ORIGINS
  TOKENIZERS_PARALLELISM
  COSYVOICE_MODEL_DIR
  COSYVOICE_API_OUTPUT_DIR
  COSYVOICE_API_HISTORY_SIZE
  COSYVOICE_API_AUDIT_SIZE
  COSYVOICE_API_SUGGESTIONS_PER_FIELD
  COSYVOICE_API_MAX_UPLOAD_BYTES
)

for key in "${required_keys[@]}"; do
  value="${!key:-}"
  if [[ -z "$value" ]]; then
    echo "[ssot] Missing required key '$key' in $SSOT_ENV_FILE" >&2
    exit 1
  fi
done
