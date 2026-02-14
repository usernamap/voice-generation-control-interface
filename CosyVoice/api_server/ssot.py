from __future__ import annotations

import os
import re
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
MONOREPO_ROOT = REPO_ROOT.parent
SSOT_ENV_PATH = MONOREPO_ROOT / "config" / "ssot.env"
_ENV_KEY_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def load_ssot_env() -> Path:
    if not SSOT_ENV_PATH.exists():
        raise RuntimeError(f"Missing SSOT config file: {SSOT_ENV_PATH}")

    for line_no, raw_line in enumerate(SSOT_ENV_PATH.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if "=" not in line:
            raise RuntimeError(f"Invalid SSOT entry at {SSOT_ENV_PATH}:{line_no}: '{raw_line}'")

        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()

        if not _ENV_KEY_PATTERN.match(key):
            raise RuntimeError(f"Invalid SSOT key '{key}' at {SSOT_ENV_PATH}:{line_no}")
        if not value:
            raise RuntimeError(f"Empty SSOT value for '{key}' at {SSOT_ENV_PATH}:{line_no}")

        os.environ[key] = value

    return SSOT_ENV_PATH


def require_env(name: str) -> str:
    value = os.environ.get(name)
    if value is None or not value.strip():
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value.strip()


def require_int_env(name: str) -> int:
    raw = require_env(name)
    try:
        return int(raw)
    except ValueError as exc:
        raise RuntimeError(f"Environment variable '{name}' must be an integer, got '{raw}'") from exc
