#!/usr/bin/env python3
from __future__ import annotations

import asyncio
import hashlib
import json
import mimetypes
import os
import queue
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import torch
import torchaudio
from fastapi import FastAPI, HTTPException, Query, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from starlette.datastructures import UploadFile as StarletteUploadFile

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))
MATCHA_PATH = REPO_ROOT / "third_party" / "Matcha-TTS"
if str(MATCHA_PATH) not in sys.path:
    sys.path.append(str(MATCHA_PATH))

from api_server.ssot import load_ssot_env, require_env, require_int_env
from cosyvoice.cli.cosyvoice import AutoModel

load_ssot_env()
os.environ["TOKENIZERS_PARALLELISM"] = require_env("TOKENIZERS_PARALLELISM")


def _resolve_repo_path(raw_path: str) -> Path:
    path = Path(raw_path)
    if path.is_absolute():
        return path
    return (REPO_ROOT / path).resolve()


MODEL_DIR_DEFAULT = str(_resolve_repo_path(require_env("COSYVOICE_MODEL_DIR")))
OUTPUT_DIR = _resolve_repo_path(require_env("COSYVOICE_API_OUTPUT_DIR"))
STATE_DIR = OUTPUT_DIR / "_state"
UPLOAD_DIR = OUTPUT_DIR / "_uploads"
MEDIA_DIR = OUTPUT_DIR / "_media"
CONVERT_DIR = OUTPUT_DIR / "_converted"

MAX_HISTORY_ITEMS = require_int_env("COSYVOICE_API_HISTORY_SIZE")
MAX_AUDIT_EVENTS = require_int_env("COSYVOICE_API_AUDIT_SIZE")
MAX_SUGGESTIONS_PER_FIELD = require_int_env("COSYVOICE_API_SUGGESTIONS_PER_FIELD")
MAX_UPLOAD_BYTES = require_int_env("COSYVOICE_API_MAX_UPLOAD_BYTES")

HISTORY_STATE_PATH = STATE_DIR / "history.json"
MEDIA_STATE_PATH = STATE_DIR / "media.json"
SUGGESTIONS_STATE_PATH = STATE_DIR / "suggestions.json"
AUDIT_LOG_PATH = STATE_DIR / "audit_events.jsonl"

CONVERSION_FORMATS: dict[str, dict[str, str]] = {
    "wav": {"ext": ".wav", "mime": "audio/wav", "codec": "pcm_s16le", "container": "wav"},
    "mp3": {"ext": ".mp3", "mime": "audio/mpeg", "codec": "libmp3lame", "container": "mp3"},
    "flac": {"ext": ".flac", "mime": "audio/flac", "codec": "flac", "container": "flac"},
    "ogg": {"ext": ".ogg", "mime": "audio/ogg", "codec": "libvorbis", "container": "ogg"},
    "m4a": {"ext": ".m4a", "mime": "audio/mp4", "codec": "aac", "container": "ipod"},
    "mp4": {"ext": ".mp4", "mime": "audio/mp4", "codec": "aac", "container": "mp4"},
}

FEATURE_REGISTRY: dict[str, dict[str, Any]] = {
    "zero_shot": {
        "id": "zero_shot",
        "title": "Zero-Shot Voice Cloning",
        "description": "Synthesize speech from text using a prompt transcript + prompt audio voice reference.",
        "method": "inference_zero_shot",
        "supported_model_types": ["CosyVoice", "CosyVoice2", "CosyVoice3"],
        "text_fields": [
            {"name": "tts_text", "label": "Target Text", "type": "textarea", "required": True},
            {"name": "prompt_text", "label": "Prompt Transcript", "type": "textarea", "required": True},
            {
                "name": "instruction",
                "label": "Instruction Prefix",
                "type": "text",
                "required": False,
                "default": "You are a helpful assistant.",
            },
            {"name": "zero_shot_spk_id", "label": "Saved Speaker ID", "type": "text", "required": False},
        ],
        "audio_fields": [
            {"name": "prompt_wav", "label": "Prompt Audio", "required": True},
        ],
        "options": [
            {"name": "speed", "label": "Speed", "type": "number", "required": False, "default": 1.0},
            {"name": "stream", "label": "Stream", "type": "boolean", "required": False, "default": False},
            {
                "name": "text_frontend",
                "label": "Text Frontend",
                "type": "boolean",
                "required": False,
                "default": True,
            },
        ],
    },
    "cross_lingual": {
        "id": "cross_lingual",
        "title": "Cross-Lingual Cloning",
        "description": "Clone prompt voice while speaking target text in another language.",
        "method": "inference_cross_lingual",
        "supported_model_types": ["CosyVoice", "CosyVoice2", "CosyVoice3"],
        "text_fields": [
            {"name": "tts_text", "label": "Target Text", "type": "textarea", "required": True},
            {"name": "zero_shot_spk_id", "label": "Saved Speaker ID", "type": "text", "required": False},
        ],
        "audio_fields": [
            {"name": "prompt_wav", "label": "Prompt Audio", "required": True},
        ],
        "options": [
            {"name": "speed", "label": "Speed", "type": "number", "required": False, "default": 1.0},
            {"name": "stream", "label": "Stream", "type": "boolean", "required": False, "default": False},
            {
                "name": "text_frontend",
                "label": "Text Frontend",
                "type": "boolean",
                "required": False,
                "default": True,
            },
        ],
    },
    "instruct2": {
        "id": "instruct2",
        "title": "Instruct2 (CosyVoice2/3)",
        "description": "Apply style/language/emotion instruction with prompt audio guidance.",
        "method": "inference_instruct2",
        "supported_model_types": ["CosyVoice2", "CosyVoice3"],
        "text_fields": [
            {"name": "tts_text", "label": "Target Text", "type": "textarea", "required": True},
            {"name": "instruct_text", "label": "Instruction", "type": "textarea", "required": True},
            {"name": "zero_shot_spk_id", "label": "Saved Speaker ID", "type": "text", "required": False},
        ],
        "audio_fields": [
            {"name": "prompt_wav", "label": "Prompt Audio", "required": True},
        ],
        "options": [
            {"name": "speed", "label": "Speed", "type": "number", "required": False, "default": 1.0},
            {"name": "stream", "label": "Stream", "type": "boolean", "required": False, "default": False},
            {
                "name": "text_frontend",
                "label": "Text Frontend",
                "type": "boolean",
                "required": False,
                "default": True,
            },
        ],
    },
    "sft": {
        "id": "sft",
        "title": "SFT Speaker Synthesis",
        "description": "Use a registered speaker ID from the model speaker bank.",
        "method": "inference_sft",
        "supported_model_types": ["CosyVoice", "CosyVoice2", "CosyVoice3"],
        "text_fields": [
            {"name": "tts_text", "label": "Target Text", "type": "textarea", "required": True},
            {"name": "spk_id", "label": "Speaker ID", "type": "text", "required": True},
        ],
        "audio_fields": [],
        "options": [
            {"name": "speed", "label": "Speed", "type": "number", "required": False, "default": 1.0},
            {"name": "stream", "label": "Stream", "type": "boolean", "required": False, "default": False},
            {
                "name": "text_frontend",
                "label": "Text Frontend",
                "type": "boolean",
                "required": False,
                "default": True,
            },
        ],
    },
    "vc": {
        "id": "vc",
        "title": "Voice Conversion (VC)",
        "description": "Convert source speech content into prompt speaker voice.",
        "method": "inference_vc",
        "supported_model_types": ["CosyVoice", "CosyVoice2", "CosyVoice3"],
        "text_fields": [],
        "audio_fields": [
            {"name": "source_wav", "label": "Source Audio", "required": True},
            {"name": "prompt_wav", "label": "Prompt Audio", "required": True},
        ],
        "options": [
            {"name": "speed", "label": "Speed", "type": "number", "required": False, "default": 1.0},
            {"name": "stream", "label": "Stream", "type": "boolean", "required": False, "default": False},
        ],
    },
    "instruct": {
        "id": "instruct",
        "title": "Instruct (CosyVoice 1 only)",
        "description": "Instruction-driven synthesis for CosyVoice v1 models.",
        "method": "inference_instruct",
        "supported_model_types": ["CosyVoice"],
        "text_fields": [
            {"name": "tts_text", "label": "Target Text", "type": "textarea", "required": True},
            {"name": "spk_id", "label": "Speaker ID", "type": "text", "required": True},
            {"name": "instruct_text", "label": "Instruction", "type": "textarea", "required": True},
        ],
        "audio_fields": [],
        "options": [
            {"name": "speed", "label": "Speed", "type": "number", "required": False, "default": 1.0},
            {"name": "stream", "label": "Stream", "type": "boolean", "required": False, "default": False},
            {
                "name": "text_frontend",
                "label": "Text Frontend",
                "type": "boolean",
                "required": False,
                "default": True,
            },
        ],
    },
}

SPEAKER_OPERATIONS: list[dict[str, Any]] = [
    {
        "id": "list_speakers",
        "title": "List Available Speakers",
        "description": "Read speaker IDs from model speaker bank.",
    },
    {
        "id": "add_zero_shot_speaker",
        "title": "Add Zero-Shot Speaker",
        "description": "Register a new speaker from prompt transcript + prompt audio.",
    },
    {
        "id": "save_speakers",
        "title": "Save Speaker Bank",
        "description": "Persist speaker bank (`spk2info.pt`) to model directory.",
    },
]


class RuntimeState:
    def __init__(self) -> None:
        self.model = None
        self.model_type = ""
        self.model_dir = ""
        self.sample_rate = 24000
        self.loaded_at = ""
        self.lock = threading.RLock()

    def load_model(self, model_dir: str) -> None:
        resolved = Path(model_dir)
        if not resolved.is_absolute():
            resolved = (REPO_ROOT / resolved).resolve()
        if not resolved.exists():
            raise FileNotFoundError(f"Model directory not found: {resolved}")

        model = AutoModel(model_dir=str(resolved))
        self.model = model
        self.model_type = model.__class__.__name__
        self.model_dir = str(resolved)
        self.sample_rate = int(model.sample_rate)
        self.loaded_at = datetime.now(timezone.utc).isoformat()

    def ensure_loaded(self) -> None:
        if self.model is None:
            self.load_model(MODEL_DIR_DEFAULT)


class EventBus:
    def __init__(self) -> None:
        self.lock = threading.RLock()
        self.subscribers: set[queue.Queue[dict[str, Any]]] = set()
        self.events: list[dict[str, Any]] = []

    def publish(self, event_type: str, payload: dict[str, Any]) -> dict[str, Any]:
        event = {
            "id": uuid.uuid4().hex,
            "type": event_type,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "payload": payload,
        }

        with self.lock:
            self.events.append(event)
            while len(self.events) > MAX_AUDIT_EVENTS:
                self.events.pop(0)

            dead: list[queue.Queue[dict[str, Any]]] = []
            for subscriber in self.subscribers:
                try:
                    subscriber.put_nowait(event)
                except queue.Full:
                    dead.append(subscriber)

            for subscriber in dead:
                self.subscribers.discard(subscriber)

        _append_audit_log(event)
        return event

    def subscribe(self) -> queue.Queue[dict[str, Any]]:
        subscription: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=64)
        with self.lock:
            self.subscribers.add(subscription)
        return subscription

    def unsubscribe(self, subscription: queue.Queue[dict[str, Any]]) -> None:
        with self.lock:
            self.subscribers.discard(subscription)

    def recent(self, limit: int) -> list[dict[str, Any]]:
        with self.lock:
            if limit <= 0:
                return []
            return self.events[-limit:]


STATE = RuntimeState()
EVENT_BUS = EventBus()

HISTORY: list[dict[str, Any]] = []
HISTORY_BY_ID: dict[str, dict[str, Any]] = {}
HISTORY_LOCK = threading.RLock()

MEDIA_LIBRARY: list[dict[str, Any]] = []
MEDIA_BY_ID: dict[str, dict[str, Any]] = {}
MEDIA_BY_HASH: dict[str, dict[str, Any]] = {}
MEDIA_LOCK = threading.RLock()

FIELD_SUGGESTIONS: dict[str, dict[str, dict[str, dict[str, Any]]]] = {}
SUGGESTIONS_LOCK = threading.RLock()


app = FastAPI(
    title="CosyVoice Unified API",
    description="Centralized Python API exposing CosyVoice generation features and speaker operations.",
    version="2.0.0",
)

cors_origins = [
    origin.strip()
    for origin in require_env("COSYVOICE_CORS_ORIGINS").split(",")
    if origin.strip()
]
if not cors_origins:
    raise RuntimeError("COSYVOICE_CORS_ORIGINS must contain at least one origin.")
app.add_middleware(
    CORSMiddleware,
    allow_origins=cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default


def _save_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    temp.replace(path)


def _append_audit_log(event: dict[str, Any]) -> None:
    AUDIT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    with AUDIT_LOG_PATH.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(event, ensure_ascii=False) + "\n")


def _hydrate_event_cache_from_log() -> None:
    if not AUDIT_LOG_PATH.exists():
        return

    lines = AUDIT_LOG_PATH.read_text(encoding="utf-8").splitlines()
    events: list[dict[str, Any]] = []
    for line in lines[-MAX_AUDIT_EVENTS:]:
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict) and all(key in event for key in ("id", "type", "created_at", "payload")):
            events.append(event)

    with EVENT_BUS.lock:
        EVENT_BUS.events = events


def _coerce_value(value: Any, expected_type: str) -> Any:
    if expected_type == "boolean":
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return bool(value)
        if value is None:
            return False
        normalized = str(value).strip().lower()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
        raise ValueError(f"Cannot parse boolean value: {value}")
    if expected_type == "number":
        return float(value)
    return str(value)


async def _parse_multipart_payload(request: Request) -> tuple[dict[str, Any], dict[str, UploadFile]]:
    form = await request.form()
    payload: dict[str, Any] = {}
    files: dict[str, UploadFile] = {}

    payload_blob = form.get("payload")
    if payload_blob:
        try:
            payload = json.loads(str(payload_blob))
        except json.JSONDecodeError as exc:
            raise HTTPException(status_code=400, detail=f"Invalid JSON payload: {exc}") from exc

    for key, value in form.multi_items():
        if isinstance(value, StarletteUploadFile):
            files[key] = value
        elif key != "payload":
            payload[key] = value

    return payload, files


async def _write_upload_to_disk(upload: UploadFile, target_dir: Path = UPLOAD_DIR) -> Path:
    target_dir.mkdir(parents=True, exist_ok=True)
    suffix = Path(upload.filename or "").suffix or ".wav"
    target = target_dir / f"{uuid.uuid4().hex}{suffix}"
    data = await upload.read()
    if not data:
        raise HTTPException(status_code=400, detail=f"Uploaded file is empty: {upload.filename}")
    if len(data) > MAX_UPLOAD_BYTES:
        max_mb = MAX_UPLOAD_BYTES / (1024 * 1024)
        raise HTTPException(
            status_code=413,
            detail=f"Uploaded file exceeds max size ({max_mb:.1f} MB): {upload.filename}",
        )
    target.write_bytes(data)
    return target


async def _read_upload_bytes(upload: UploadFile) -> bytes:
    data = await upload.read()
    if not data:
        raise HTTPException(status_code=400, detail=f"Uploaded file is empty: {upload.filename}")
    if len(data) > MAX_UPLOAD_BYTES:
        max_mb = MAX_UPLOAD_BYTES / (1024 * 1024)
        raise HTTPException(
            status_code=413,
            detail=f"Uploaded file exceeds max size ({max_mb:.1f} MB): {upload.filename}",
        )
    return data


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_file(path: Path) -> str | None:
    try:
        return _sha256_bytes(path.read_bytes())
    except OSError:
        return None


def _sanitize_media_label_token(value: str, fallback: str = "audio") -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9]+", "_", value.strip().lower()).strip("_")
    return (cleaned or fallback)[:64]


def _guess_media_suffix(original_name: str, mime_type: str) -> str:
    suffix = Path(original_name).suffix
    if suffix:
        return suffix.lower()
    guessed = mimetypes.guess_extension(mime_type)
    return guessed.lower() if guessed else ".bin"


def _auto_media_label(kind: str, original_name: str, created_at: datetime, content_hash: str) -> str:
    kind_token = _sanitize_media_label_token(kind, fallback="generic")
    name_token = _sanitize_media_label_token(Path(original_name).stem or "audio")
    timestamp = created_at.strftime("%Y-%m-%d_%H-%M-%S")
    return f"{kind_token}_{timestamp}_{name_token}_{content_hash[:8]}"


async def _upsert_media_from_upload(
    upload: UploadFile,
    *,
    kind: str,
    label: str,
    origin: str,
) -> tuple[dict[str, Any], bool, bool]:
    data = await _read_upload_bytes(upload)
    content_hash = _sha256_bytes(data)
    original_name = str(upload.filename or "untitled")
    guessed_mime = upload.content_type or mimetypes.guess_type(original_name)[0] or "application/octet-stream"

    with MEDIA_LOCK:
        existing = MEDIA_BY_HASH.get(content_hash)
        if existing is not None and Path(existing["file_path"]).exists():
            return existing, False, True

    created_at_dt = datetime.now(timezone.utc)
    resolved_label = label.strip() or _auto_media_label(kind, original_name, created_at_dt, content_hash)
    suffix = _guess_media_suffix(original_name, guessed_mime)
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    media_path = MEDIA_DIR / f"{uuid.uuid4().hex}{suffix}"
    media_path.write_bytes(data)

    item: dict[str, Any] = {
        "id": uuid.uuid4().hex,
        "label": resolved_label,
        "kind": kind,
        "created_at": created_at_dt.isoformat(),
        "file_path": str(media_path),
        "size_bytes": int(len(data)),
        "original_name": original_name,
        "mime_type": guessed_mime,
        "content_hash": content_hash,
    }
    if origin.strip():
        item["origin"] = origin.strip()

    with MEDIA_LOCK:
        existing = MEDIA_BY_HASH.get(content_hash)
        if existing is not None and Path(existing["file_path"]).exists():
            media_path.unlink(missing_ok=True)
            return existing, False, True

        MEDIA_LIBRARY.append(item)
        MEDIA_BY_ID[item["id"]] = item
        MEDIA_BY_HASH[content_hash] = item
    _save_media_state()
    return item, True, False


def _cleanup_temp_files(paths: list[Path]) -> None:
    for path in paths:
        try:
            if path.exists():
                path.unlink()
        except OSError:
            pass


def _active_features() -> list[dict[str, Any]]:
    STATE.ensure_loaded()
    features: list[dict[str, Any]] = []
    for feature in FEATURE_REGISTRY.values():
        if STATE.model_type in feature["supported_model_types"]:
            features.append(feature)
    return features


def _trim_history_if_needed() -> None:
    while len(HISTORY) > MAX_HISTORY_ITEMS:
        stale = HISTORY.pop(0)
        HISTORY_BY_ID.pop(stale["id"], None)
        stale_path = Path(stale["file_path"])
        if stale_path.exists():
            stale_path.unlink(missing_ok=True)


def _safe_preview(value: Any, max_chars: int = 160) -> Any:
    if isinstance(value, str):
        stripped = value.strip()
        if len(stripped) <= max_chars:
            return stripped
        return f"{stripped[: max_chars - 3]}..."
    return value


def _safe_inputs(inputs: dict[str, Any]) -> dict[str, Any]:
    safe: dict[str, Any] = {}
    for key, value in inputs.items():
        safe[key] = _safe_preview(value, max_chars=2000)
    return safe


def _normalize_suggestion_value(value: Any) -> str:
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return str(value)
    return str(value).strip()


def _record_suggestions(feature_id: str, payload: dict[str, Any], spec: dict[str, Any]) -> None:
    fields_to_track = [field["name"] for field in spec.get("text_fields", [])] + [
        option["name"] for option in spec.get("options", [])
    ]

    now = datetime.now(timezone.utc).isoformat()
    updated = False
    with SUGGESTIONS_LOCK:
        feature_bucket = FIELD_SUGGESTIONS.setdefault(feature_id, {})
        for field_name in fields_to_track:
            raw_value = payload.get(field_name)
            if raw_value in (None, ""):
                continue

            normalized_value = _normalize_suggestion_value(raw_value)
            if not normalized_value:
                continue

            field_bucket = feature_bucket.setdefault(field_name, {})
            entry = field_bucket.get(normalized_value)
            if entry is None:
                field_bucket[normalized_value] = {
                    "value": normalized_value,
                    "count": 1,
                    "last_used": now,
                }
            else:
                entry["count"] = int(entry.get("count", 0)) + 1
                entry["last_used"] = now

            ordered = sorted(
                field_bucket.values(),
                key=lambda item: (int(item.get("count", 0)), str(item.get("last_used", ""))),
                reverse=True,
            )
            limited = ordered[:MAX_SUGGESTIONS_PER_FIELD]
            feature_bucket[field_name] = {item["value"]: item for item in limited}
            updated = True

    if updated:
        _save_json(SUGGESTIONS_STATE_PATH, FIELD_SUGGESTIONS)


def _load_history_state() -> None:
    payload = _load_json(HISTORY_STATE_PATH, default={"items": []})
    raw_items = payload.get("items", []) if isinstance(payload, dict) else []

    loaded: list[dict[str, Any]] = []
    for item in raw_items:
        if not isinstance(item, dict):
            continue
        if "id" not in item or "file_path" not in item:
            continue
        path = Path(item["file_path"])
        if not path.exists():
            continue
        loaded.append(item)

    with HISTORY_LOCK:
        HISTORY.clear()
        HISTORY.extend(loaded[-MAX_HISTORY_ITEMS:])
        HISTORY_BY_ID.clear()
        for item in HISTORY:
            HISTORY_BY_ID[item["id"]] = item


def _save_history_state() -> None:
    with HISTORY_LOCK:
        snapshot = list(HISTORY)
    _save_json(HISTORY_STATE_PATH, {"items": snapshot})


def _load_media_state() -> None:
    payload = _load_json(MEDIA_STATE_PATH, default={"items": []})
    raw_items = payload.get("items", []) if isinstance(payload, dict) else []

    loaded: list[dict[str, Any]] = []
    seen_hashes: set[str] = set()
    updated = False
    for item in raw_items:
        if not isinstance(item, dict):
            updated = True
            continue
        if "id" not in item or "file_path" not in item:
            updated = True
            continue
        path = Path(item["file_path"])
        if not path.exists():
            updated = True
            continue
        content_hash = str(item.get("content_hash", "")).strip().lower()
        if not content_hash:
            computed = _sha256_file(path)
            if not computed:
                updated = True
                continue
            content_hash = computed
            item["content_hash"] = content_hash
            updated = True
        if content_hash in seen_hashes:
            updated = True
            continue
        seen_hashes.add(content_hash)
        kind = str(item.get("kind", "generic") or "generic").strip().lower() or "generic"
        if kind not in {"prompt", "source", "generic"}:
            kind = "generic"
            updated = True
        item["kind"] = kind
        original_name = str(item.get("original_name", path.name) or path.name)
        item["original_name"] = original_name
        if not str(item.get("label", "")).strip():
            try:
                created_at_dt = datetime.fromisoformat(str(item.get("created_at", "")))
            except ValueError:
                created_at_dt = datetime.now(timezone.utc)
            item["label"] = _auto_media_label(item["kind"], original_name, created_at_dt, content_hash)
            updated = True
        loaded.append(item)

    with MEDIA_LOCK:
        MEDIA_LIBRARY.clear()
        MEDIA_LIBRARY.extend(loaded)
        MEDIA_BY_ID.clear()
        MEDIA_BY_HASH.clear()
        for item in MEDIA_LIBRARY:
            MEDIA_BY_ID[item["id"]] = item
            MEDIA_BY_HASH[item["content_hash"]] = item

    if updated:
        _save_media_state()


def _save_media_state() -> None:
    with MEDIA_LOCK:
        snapshot = list(MEDIA_LIBRARY)
    _save_json(MEDIA_STATE_PATH, {"items": snapshot})


def _load_suggestions_state() -> None:
    payload = _load_json(SUGGESTIONS_STATE_PATH, default={})
    if not isinstance(payload, dict):
        payload = {}
    with SUGGESTIONS_LOCK:
        FIELD_SUGGESTIONS.clear()
        FIELD_SUGGESTIONS.update(payload)


def _conversion_target_path(source_id: str, fmt: str) -> Path:
    info = CONVERSION_FORMATS[fmt]
    return CONVERT_DIR / f"{source_id}{info['ext']}"


def _require_ffmpeg() -> str:
    ffmpeg_bin = shutil.which("ffmpeg")
    if not ffmpeg_bin:
        raise HTTPException(
            status_code=500,
            detail="ffmpeg is required for media conversion (install ffmpeg and retry).",
        )
    return ffmpeg_bin


def _convert_media(source_path: Path, source_id: str, fmt: str) -> tuple[Path, str]:
    fmt = fmt.lower()
    if fmt not in CONVERSION_FORMATS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported format '{fmt}'. Supported: {', '.join(CONVERSION_FORMATS.keys())}",
        )

    conversion = CONVERSION_FORMATS[fmt]
    if fmt == "wav":
        return source_path, conversion["mime"]

    CONVERT_DIR.mkdir(parents=True, exist_ok=True)
    target_path = _conversion_target_path(source_id, fmt)
    if target_path.exists():
        return target_path, conversion["mime"]

    ffmpeg_bin = _require_ffmpeg()
    command = [
        ffmpeg_bin,
        "-y",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        str(source_path),
        "-vn",
        "-acodec",
        conversion["codec"],
        "-f",
        conversion["container"],
        str(target_path),
    ]

    result = subprocess.run(command, capture_output=True, text=True, check=False)
    if result.returncode != 0:
        target_path.unlink(missing_ok=True)
        stderr = (result.stderr or "unknown ffmpeg error").strip()
        raise HTTPException(status_code=500, detail=f"Media conversion failed: {stderr}")

    return target_path, conversion["mime"]


def _serialize_history_item(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": item["id"],
        "feature_id": item["feature_id"],
        "created_at": item["created_at"],
        "duration_seconds": item["duration_seconds"],
        "sample_rate": item["sample_rate"],
        "audio_url": f"/api/history/{item['id']}/audio",
        "inputs": item.get("inputs", {}),
        "inputs_preview": item.get("inputs_preview", {}),
    }


def _serialize_media_item(item: dict[str, Any]) -> dict[str, Any]:
    return {
        "id": item["id"],
        "label": item["label"],
        "kind": item["kind"],
        "created_at": item["created_at"],
        "size_bytes": item["size_bytes"],
        "original_name": item["original_name"],
        "mime_type": item["mime_type"],
        "file_url": f"/api/media/{item['id']}/file",
    }


def _sse_message(event: dict[str, Any]) -> str:
    body = json.dumps(event, ensure_ascii=False)
    return f"event: {event['type']}\nid: {event['id']}\ndata: {body}\n\n"


@app.on_event("startup")
def _startup() -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    MEDIA_DIR.mkdir(parents=True, exist_ok=True)
    CONVERT_DIR.mkdir(parents=True, exist_ok=True)

    _load_history_state()
    _load_media_state()
    _load_suggestions_state()
    _hydrate_event_cache_from_log()

    STATE.ensure_loaded()
    EVENT_BUS.publish(
        "server_started",
        {
            "model_type": STATE.model_type,
            "model_dir": STATE.model_dir,
            "history_count": len(HISTORY),
            "media_count": len(MEDIA_LIBRARY),
        },
    )


@app.get("/api/health")
def health() -> dict[str, Any]:
    model_loaded = STATE.model is not None
    return {
        "status": "ok",
        "model_loaded": model_loaded,
        "model_type": STATE.model_type if model_loaded else None,
        "model_dir": STATE.model_dir if model_loaded else None,
        "loaded_at": STATE.loaded_at if model_loaded else None,
    }


@app.get("/api/model")
def model_info() -> dict[str, Any]:
    STATE.ensure_loaded()
    return {
        "model_type": STATE.model_type,
        "model_dir": STATE.model_dir,
        "sample_rate": STATE.sample_rate,
        "loaded_at": STATE.loaded_at,
    }


@app.post("/api/model/reload")
def reload_model(body: dict[str, str]) -> dict[str, Any]:
    model_dir = str(body.get("model_dir", "")).strip()
    if not model_dir:
        raise HTTPException(status_code=400, detail="Missing required field: model_dir")

    with STATE.lock:
        try:
            STATE.load_model(model_dir)
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(status_code=400, detail=f"Model reload failed: {exc}") from exc

    EVENT_BUS.publish(
        "model_reloaded",
        {
            "model_type": STATE.model_type,
            "model_dir": STATE.model_dir,
            "sample_rate": STATE.sample_rate,
        },
    )
    return {"ok": True, "model_type": STATE.model_type, "model_dir": STATE.model_dir}


@app.get("/api/capabilities")
def capabilities() -> dict[str, Any]:
    STATE.ensure_loaded()
    return {
        "model": {
            "model_type": STATE.model_type,
            "model_dir": STATE.model_dir,
            "sample_rate": STATE.sample_rate,
            "loaded_at": STATE.loaded_at,
        },
        "features": _active_features(),
        "speaker_operations": SPEAKER_OPERATIONS,
        "platform": {
            "events_sse": True,
            "history_persistence": True,
            "media_library": True,
            "field_suggestions": True,
            "supported_conversions": list(CONVERSION_FORMATS.keys()),
            "max_upload_bytes": MAX_UPLOAD_BYTES,
            "stats_endpoint": "/api/stats",
        },
    }


@app.get("/api/stats")
def stats() -> dict[str, Any]:
    STATE.ensure_loaded()
    with STATE.lock:
        speakers = STATE.model.list_available_spks()
        sample_rate = STATE.sample_rate
        model_type = STATE.model_type
        model_dir = STATE.model_dir
        loaded_at = STATE.loaded_at

    with HISTORY_LOCK:
        history_snapshot = list(HISTORY)
    with MEDIA_LOCK:
        media_snapshot = list(MEDIA_LIBRARY)
    with EVENT_BUS.lock:
        events_snapshot = list(EVENT_BUS.events)
    with SUGGESTIONS_LOCK:
        suggestions_snapshot = FIELD_SUGGESTIONS.copy()

    history_by_feature: dict[str, int] = {}
    for item in history_snapshot:
        feature_id = str(item.get("feature_id", "unknown"))
        history_by_feature[feature_id] = history_by_feature.get(feature_id, 0) + 1

    total_suggestion_values = 0
    for fields in suggestions_snapshot.values():
        for values in fields.values():
            total_suggestion_values += len(values)

    latest_item = history_snapshot[-1] if history_snapshot else None
    latest = None
    if latest_item is not None:
        latest = {
            "id": latest_item.get("id"),
            "feature_id": latest_item.get("feature_id"),
            "created_at": latest_item.get("created_at"),
            "duration_seconds": latest_item.get("duration_seconds"),
        }

    return {
        "model": {
            "model_type": model_type,
            "model_dir": model_dir,
            "sample_rate": sample_rate,
            "loaded_at": loaded_at,
        },
        "counts": {
            "features": len(_active_features()),
            "speakers": len(speakers),
            "history_items": len(history_snapshot),
            "media_items": len(media_snapshot),
            "audit_events": len(events_snapshot),
            "suggestion_values": total_suggestion_values,
        },
        "history_by_feature": history_by_feature,
        "latest_generation": latest,
    }


@app.get("/api/speakers")
def list_speakers() -> dict[str, Any]:
    STATE.ensure_loaded()
    with STATE.lock:
        speakers = STATE.model.list_available_spks()
    return {"count": len(speakers), "speakers": speakers}


@app.post("/api/speakers/save")
def save_speakers() -> dict[str, Any]:
    STATE.ensure_loaded()
    with STATE.lock:
        STATE.model.save_spkinfo()
        speaker_count = len(STATE.model.list_available_spks())

    EVENT_BUS.publish("speakers_saved", {"count": speaker_count})
    return {"ok": True}


@app.post("/api/speakers/zero-shot")
async def add_zero_shot_speaker(request: Request) -> dict[str, Any]:
    STATE.ensure_loaded()
    payload, files = await _parse_multipart_payload(request)
    prompt_text = str(payload.get("prompt_text", "")).strip()
    zero_shot_spk_id = str(payload.get("zero_shot_spk_id", "")).strip()
    prompt_wav_media_id = str(payload.get("prompt_wav_media_id", "")).strip()

    if not prompt_text:
        raise HTTPException(status_code=400, detail="Missing required field: prompt_text")
    if not zero_shot_spk_id:
        raise HTTPException(status_code=400, detail="Missing required field: zero_shot_spk_id")
    if "prompt_wav" not in files and not prompt_wav_media_id:
        raise HTTPException(status_code=400, detail="Missing required file: prompt_wav")

    temp_files: list[Path] = []
    try:
        if "prompt_wav" in files:
            prompt_path = await _write_upload_to_disk(files["prompt_wav"])
            temp_files.append(prompt_path)
        else:
            with MEDIA_LOCK:
                media_item = MEDIA_BY_ID.get(prompt_wav_media_id)
            if media_item is None:
                raise HTTPException(
                    status_code=400,
                    detail=f"Unknown media item for prompt_wav: {prompt_wav_media_id}",
                )
            prompt_path = Path(media_item["file_path"])
            if not prompt_path.exists():
                raise HTTPException(status_code=400, detail=f"Media file missing on disk: {prompt_wav_media_id}")

        with STATE.lock:
            ok = STATE.model.add_zero_shot_spk(prompt_text, str(prompt_path), zero_shot_spk_id)

        EVENT_BUS.publish(
            "speaker_added",
            {
                "speaker_id": zero_shot_spk_id,
                "ok": bool(ok),
            },
        )
        return {"ok": bool(ok), "zero_shot_spk_id": zero_shot_spk_id}
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=f"Failed to add zero-shot speaker: {exc}") from exc
    finally:
        _cleanup_temp_files(temp_files)


@app.get("/api/history")
def history(
    limit: int = Query(MAX_HISTORY_ITEMS, ge=1, le=MAX_HISTORY_ITEMS),
    feature_id: str | None = Query(None),
    q: str | None = Query(None),
) -> dict[str, Any]:
    with HISTORY_LOCK:
        filtered = list(reversed(HISTORY))

    if feature_id:
        normalized_feature = feature_id.strip()
        filtered = [item for item in filtered if str(item.get("feature_id", "")) == normalized_feature]

    if q:
        needle = q.strip().lower()
        if needle:
            filtered = [
                item
                for item in filtered
                if needle in str(item.get("id", "")).lower()
                or needle in str(item.get("feature_id", "")).lower()
                or needle in json.dumps(item.get("inputs_preview", {}), ensure_ascii=False).lower()
            ]

    total = len(filtered)
    items = [_serialize_history_item(item) for item in filtered[:limit]]
    return {"count": len(items), "total": total, "items": items}


@app.delete("/api/history")
def clear_history() -> dict[str, Any]:
    removed = 0
    with HISTORY_LOCK:
        while HISTORY:
            item = HISTORY.pop()
            removed += 1
            HISTORY_BY_ID.pop(item["id"], None)
            path = Path(item["file_path"])
            if path.exists():
                path.unlink(missing_ok=True)
    _save_history_state()

    EVENT_BUS.publish("history_cleared", {"removed": removed})
    return {"ok": True}


@app.get("/api/history/{item_id}/audio")
def history_audio(item_id: str) -> FileResponse:
    with HISTORY_LOCK:
        item = HISTORY_BY_ID.get(item_id)
    if item is None:
        raise HTTPException(status_code=404, detail=f"Unknown history item: {item_id}")

    path = Path(item["file_path"])
    if not path.exists():
        raise HTTPException(status_code=404, detail="Audio file not found on disk")

    return FileResponse(path=path, media_type="audio/wav", filename=path.name)


@app.get("/api/history/{item_id}/convert")
def convert_history_item(
    item_id: str,
    format: str = Query("mp3", description="Target format (wav/mp3/flac/ogg/m4a/mp4)"),
) -> FileResponse:
    with HISTORY_LOCK:
        item = HISTORY_BY_ID.get(item_id)
    if item is None:
        raise HTTPException(status_code=404, detail=f"Unknown history item: {item_id}")

    source_path = Path(item["file_path"])
    if not source_path.exists():
        raise HTTPException(status_code=404, detail="Audio file not found on disk")

    target_path, media_type = _convert_media(source_path, item_id, format)
    EVENT_BUS.publish(
        "media_converted",
        {
            "entity": "history",
            "entity_id": item_id,
            "format": format.lower(),
            "target_path": str(target_path),
        },
    )
    return FileResponse(path=target_path, media_type=media_type, filename=target_path.name)


@app.get("/api/media")
def list_media(
    kind: str | None = Query(None),
    limit: int = Query(500, ge=1, le=2000),
    q: str | None = Query(None),
) -> dict[str, Any]:
    with MEDIA_LOCK:
        items = list(MEDIA_LIBRARY)

    if kind:
        normalized = kind.strip().lower()
        items = [item for item in items if str(item.get("kind", "")).lower() == normalized]

    filtered = list(reversed(items))
    if q:
        needle = q.strip().lower()
        if needle:
            filtered = [
                item
                for item in filtered
                if needle in str(item.get("id", "")).lower()
                or needle in str(item.get("label", "")).lower()
                or needle in str(item.get("original_name", "")).lower()
            ]

    total = len(filtered)
    serialized = [_serialize_media_item(item) for item in filtered[:limit]]
    return {"count": len(serialized), "total": total, "items": serialized}


@app.post("/api/media")
async def create_media(request: Request) -> dict[str, Any]:
    payload, files = await _parse_multipart_payload(request)
    upload = files.get("file")
    if upload is None:
        raise HTTPException(status_code=400, detail="Missing required file: file")

    label = str(payload.get("label", "")).strip()
    origin = str(payload.get("origin", "")).strip()
    kind = str(payload.get("kind", "generic")).strip().lower() or "generic"
    allowed_kinds = {"prompt", "source", "generic"}
    if kind not in allowed_kinds:
        raise HTTPException(status_code=400, detail=f"Invalid kind: {kind}. Allowed: {', '.join(sorted(allowed_kinds))}")

    item, created, deduplicated = await _upsert_media_from_upload(upload, kind=kind, label=label, origin=origin)
    if created:
        EVENT_BUS.publish(
            "media_created",
            {
                "media_id": item["id"],
                "kind": item["kind"],
                "label": item["label"],
                "size_bytes": item["size_bytes"],
                "origin": origin or None,
            },
        )
    elif deduplicated:
        EVENT_BUS.publish(
            "media_deduplicated",
            {
                "media_id": item["id"],
                "kind": item["kind"],
                "label": item["label"],
                "origin": origin or None,
                "requested_kind": kind,
                "requested_label": label or None,
            },
        )

    return {
        "ok": True,
        "item": _serialize_media_item(item),
        "created": created,
        "deduplicated": deduplicated,
    }


@app.delete("/api/media/{media_id}")
def delete_media(media_id: str) -> dict[str, Any]:
    with MEDIA_LOCK:
        item = MEDIA_BY_ID.get(media_id)
        if item is None:
            raise HTTPException(status_code=404, detail=f"Unknown media item: {media_id}")

        MEDIA_LIBRARY[:] = [current for current in MEDIA_LIBRARY if current["id"] != media_id]
        MEDIA_BY_ID.pop(media_id, None)
        content_hash = str(item.get("content_hash", "")).strip().lower()
        if content_hash and MEDIA_BY_HASH.get(content_hash, {}).get("id") == media_id:
            MEDIA_BY_HASH.pop(content_hash, None)

    path = Path(item["file_path"])
    if path.exists():
        path.unlink(missing_ok=True)

    for fmt in CONVERSION_FORMATS:
        converted = _conversion_target_path(media_id, fmt)
        if converted.exists() and converted != path:
            converted.unlink(missing_ok=True)

    _save_media_state()
    EVENT_BUS.publish("media_deleted", {"media_id": media_id, "label": item.get("label", "")})
    return {"ok": True}


@app.get("/api/media/{media_id}/file")
def media_file(media_id: str) -> FileResponse:
    with MEDIA_LOCK:
        item = MEDIA_BY_ID.get(media_id)
    if item is None:
        raise HTTPException(status_code=404, detail=f"Unknown media item: {media_id}")

    path = Path(item["file_path"])
    if not path.exists():
        raise HTTPException(status_code=404, detail="Media file not found on disk")

    media_type = str(item.get("mime_type", "application/octet-stream"))
    filename = str(item.get("original_name", path.name))
    return FileResponse(path=path, media_type=media_type, filename=filename)


@app.get("/api/media/{media_id}/convert")
def convert_media_item(
    media_id: str,
    format: str = Query("mp3", description="Target format (wav/mp3/flac/ogg/m4a/mp4)"),
) -> FileResponse:
    with MEDIA_LOCK:
        item = MEDIA_BY_ID.get(media_id)
    if item is None:
        raise HTTPException(status_code=404, detail=f"Unknown media item: {media_id}")

    source_path = Path(item["file_path"])
    if not source_path.exists():
        raise HTTPException(status_code=404, detail="Media file not found on disk")

    target_path, media_type = _convert_media(source_path, media_id, format)
    EVENT_BUS.publish(
        "media_converted",
        {
            "entity": "media",
            "entity_id": media_id,
            "format": format.lower(),
            "target_path": str(target_path),
        },
    )
    return FileResponse(path=target_path, media_type=media_type, filename=target_path.name)


@app.get("/api/suggestions")
def suggestions(
    feature_id: str | None = Query(None),
    field_name: str | None = Query(None),
    limit: int = Query(MAX_SUGGESTIONS_PER_FIELD, ge=1, le=100),
) -> dict[str, Any]:
    with SUGGESTIONS_LOCK:
        if feature_id:
            feature_data = FIELD_SUGGESTIONS.get(feature_id, {})
            data = {feature_id: feature_data}
        else:
            data = FIELD_SUGGESTIONS.copy()

    result: dict[str, Any] = {}
    for feat, fields in data.items():
        result[feat] = {}
        for field_key, entries in fields.items():
            if field_name and field_name != field_key:
                continue
            ordered = sorted(
                entries.values(),
                key=lambda item: (int(item.get("count", 0)), str(item.get("last_used", ""))),
                reverse=True,
            )
            result[feat][field_key] = ordered[:limit]

    return {"features": result}


@app.get("/api/events")
def audit_events(
    limit: int = Query(100, ge=1, le=MAX_AUDIT_EVENTS),
    event_type: str | None = Query(None),
    q: str | None = Query(None),
) -> dict[str, Any]:
    with EVENT_BUS.lock:
        events = list(EVENT_BUS.events)

    if event_type:
        normalized_type = event_type.strip()
        events = [event for event in events if str(event.get("type", "")) == normalized_type]

    if q:
        needle = q.strip().lower()
        if needle:
            events = [
                event
                for event in events
                if needle in str(event.get("id", "")).lower()
                or needle in str(event.get("type", "")).lower()
                or needle in json.dumps(event.get("payload", {}), ensure_ascii=False).lower()
            ]

    events = events[-limit:]
    return {"count": len(events), "items": events}


@app.get("/api/events/stream")
async def event_stream(request: Request, replay: int = Query(20, ge=0, le=200)) -> StreamingResponse:
    subscription = EVENT_BUS.subscribe()

    async def iterator() -> Any:
        try:
            for event in EVENT_BUS.recent(replay):
                yield _sse_message(event)

            while True:
                if await request.is_disconnected():
                    break

                try:
                    event = await asyncio.to_thread(subscription.get, True, 1.0)
                    yield _sse_message(event)
                except queue.Empty:
                    yield ": ping\n\n"
        finally:
            EVENT_BUS.unsubscribe(subscription)

    headers = {
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
    }
    return StreamingResponse(iterator(), media_type="text/event-stream", headers=headers)


@app.post("/api/generate/{feature_id}")
async def generate(feature_id: str, request: Request) -> dict[str, Any]:
    STATE.ensure_loaded()
    spec = FEATURE_REGISTRY.get(feature_id)
    if spec is None:
        raise HTTPException(status_code=404, detail=f"Unknown feature: {feature_id}")
    if STATE.model_type not in spec["supported_model_types"]:
        raise HTTPException(
            status_code=400,
            detail=f"Feature '{feature_id}' is not supported by model type '{STATE.model_type}'",
        )

    payload, files = await _parse_multipart_payload(request)
    kwargs: dict[str, Any] = {}
    temp_files: list[Path] = []
    resolved_inputs: dict[str, Any] = {}

    EVENT_BUS.publish(
        "generation_started",
        {
            "feature_id": feature_id,
            "model_type": STATE.model_type,
        },
    )

    try:
        for field in spec["text_fields"]:
            name = field["name"]
            required = bool(field.get("required", False))
            default = field.get("default")
            value = payload.get(name, default)
            if required and (value is None or str(value).strip() == ""):
                raise HTTPException(status_code=400, detail=f"Missing required field: {name}")
            if value is None or str(value).strip() == "":
                continue
            coerced = _coerce_value(value, field.get("type", "text"))
            kwargs[name] = coerced
            resolved_inputs[name] = coerced

        for field in spec["audio_fields"]:
            name = field["name"]
            required = bool(field.get("required", False))
            upload = files.get(name)
            media_id_key = f"{name}_media_id"
            media_id = str(payload.get(media_id_key, "")).strip()
            media_item: dict[str, Any] | None = None
            if media_id:
                with MEDIA_LOCK:
                    media_item = MEDIA_BY_ID.get(media_id)
                if media_item is None:
                    raise HTTPException(status_code=400, detail=f"Unknown media item for {name}: {media_id}")

            if required and upload is None:
                if media_item is None:
                    raise HTTPException(status_code=400, detail=f"Missing required file: {name}")
            if upload is None and media_item is None:
                continue
            if upload is not None:
                audio_path = await _write_upload_to_disk(upload)
                temp_files.append(audio_path)
                kwargs[name] = str(audio_path)
                resolved_inputs[name] = str(upload.filename or audio_path.name)
            elif media_item is not None:
                media_path = Path(media_item["file_path"])
                if not media_path.exists():
                    raise HTTPException(status_code=400, detail=f"Media file missing on disk: {media_id}")
                kwargs[name] = str(media_path)
                resolved_inputs[name] = f"[media:{media_id}] {media_item.get('original_name', media_path.name)}"

        for option in spec.get("options", []):
            name = option["name"]
            expected_type = option.get("type", "text")
            if name in payload and payload[name] not in {"", None}:
                coerced = _coerce_value(payload[name], expected_type)
                kwargs[name] = coerced
                resolved_inputs[name] = coerced
            elif "default" in option:
                kwargs[name] = option["default"]
                resolved_inputs[name] = option["default"]

        if feature_id == "zero_shot" and STATE.model_type == "CosyVoice3":
            instruction = str(kwargs.pop("instruction", "You are a helpful assistant.")).strip()
            prompt_text = str(kwargs.get("prompt_text", "")).strip()
            if prompt_text and "<|endofprompt|>" not in prompt_text:
                if "<|endofprompt|>" not in instruction:
                    instruction = f"{instruction}<|endofprompt|>"
                kwargs["prompt_text"] = f"{instruction}{prompt_text}"
                resolved_inputs["prompt_text"] = kwargs["prompt_text"]

        method_name = spec["method"]
        if not hasattr(STATE.model, method_name):
            raise HTTPException(status_code=400, detail=f"Model does not expose method: {method_name}")
        method = getattr(STATE.model, method_name)

        start = time.perf_counter()
        with STATE.lock, torch.inference_mode():
            chunks = [out["tts_speech"].detach().cpu() for out in method(**kwargs)]

        if not chunks:
            raise HTTPException(status_code=500, detail="No audio generated.")

        audio_tensor = torch.cat(chunks, dim=1) if len(chunks) > 1 else chunks[0]
        audio_tensor = audio_tensor.float().cpu()

        duration = float(audio_tensor.shape[1] / STATE.sample_rate)
        elapsed = float(time.perf_counter() - start)
        rtf = elapsed / duration if duration > 0 else None

        output_id = uuid.uuid4().hex
        output_path = OUTPUT_DIR / f"{output_id}.wav"
        torchaudio.save(str(output_path), audio_tensor, STATE.sample_rate)

        item = {
            "id": output_id,
            "feature_id": feature_id,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "file_path": str(output_path),
            "duration_seconds": duration,
            "sample_rate": STATE.sample_rate,
            "inputs": _safe_inputs(resolved_inputs),
            "inputs_preview": {key: _safe_preview(value, max_chars=180) for key, value in resolved_inputs.items()},
        }

        with HISTORY_LOCK:
            HISTORY.append(item)
            HISTORY_BY_ID[output_id] = item
            _trim_history_if_needed()
        _save_history_state()

        _record_suggestions(feature_id, payload, spec)

        EVENT_BUS.publish(
            "generation_completed",
            {
                "item_id": output_id,
                "feature_id": feature_id,
                "duration_seconds": duration,
                "elapsed_seconds": elapsed,
                "rtf": rtf,
                "chunk_count": len(chunks),
            },
        )

        return {
            "ok": True,
            "id": output_id,
            "feature_id": feature_id,
            "model_type": STATE.model_type,
            "sample_rate": STATE.sample_rate,
            "duration_seconds": duration,
            "elapsed_seconds": elapsed,
            "rtf": rtf,
            "chunk_count": len(chunks),
            "audio_url": f"/api/history/{output_id}/audio",
        }
    except HTTPException as exc:
        EVENT_BUS.publish(
            "generation_failed",
            {
                "feature_id": feature_id,
                "detail": exc.detail,
            },
        )
        raise
    except Exception as exc:  # noqa: BLE001
        EVENT_BUS.publish(
            "generation_failed",
            {
                "feature_id": feature_id,
                "detail": str(exc),
            },
        )
        raise HTTPException(status_code=400, detail=f"Generation failed: {exc}") from exc
    finally:
        _cleanup_temp_files(temp_files)


@app.get("/")
def root() -> dict[str, Any]:
    return {
        "name": "CosyVoice Unified API",
        "docs": "/docs",
        "health": "/api/health",
        "capabilities": "/api/capabilities",
        "stats": "/api/stats",
        "events": "/api/events",
        "event_stream": "/api/events/stream",
    }
