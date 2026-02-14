#!/usr/bin/env python3

import os
import sys
import warnings
from pathlib import Path

import uvicorn

warnings.filterwarnings("ignore", message="pkg_resources is deprecated as an API.*", category=UserWarning)

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


def main() -> None:
    host = os.getenv("COSYVOICE_API_HOST", "127.0.0.1")
    port = int(os.getenv("COSYVOICE_API_PORT", "8000"))
    uvicorn.run("api_server.main:app", host=host, port=port, reload=False)


if __name__ == "__main__":
    main()
