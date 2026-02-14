#!/usr/bin/env python3

import sys
import warnings
from pathlib import Path

import uvicorn

warnings.filterwarnings("ignore", message="pkg_resources is deprecated as an API.*", category=UserWarning)

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from api_server.ssot import load_ssot_env, require_env, require_int_env


def main() -> None:
    load_ssot_env()
    host = require_env("COSYVOICE_API_HOST")
    port = require_int_env("COSYVOICE_API_PORT")
    uvicorn.run("api_server.main:app", host=host, port=port, reload=False)


if __name__ == "__main__":
    main()
