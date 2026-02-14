# CosyVoice Unified API

Backend FastAPI centralisant les fonctionnalités CosyVoice avec persistance locale, audit events et streaming SSE.

## Démarrage backend

```bash
cd /Users/usernamap/Documents/dev_pers/voice-generation-control-interface
make dev-backend
```

API docs: `http://127.0.0.1:8000/docs`

## Endpoints clés

### Core

- `GET /api/health`
- `GET /api/model`
- `POST /api/model/reload`
- `GET /api/capabilities` (SSOT frontend + platform features)
- `GET /api/stats` (KPI consolidés backend)

### Génération / Historique

- `POST /api/generate/{feature_id}`
- `GET /api/history`
  - options: `limit`, `feature_id`, `q`
- `DELETE /api/history`
- `GET /api/history/{id}/audio`
- `GET /api/history/{id}/convert?format=mp3|mp4|wav|flac|ogg|m4a`

### Speakers

- `GET /api/speakers`
- `POST /api/speakers/zero-shot`
  - accepte `prompt_wav` (upload) ou `prompt_wav_media_id`
- `POST /api/speakers/save`

### Media Library (CRUD)

- `GET /api/media`
  - options: `kind`, `limit`, `q`
- `POST /api/media` (multipart: `file` + `payload` JSON `{label, kind, origin}`)
  - `origin` est optionnel (contexte frontend/backend d'import)
  - réponse: `{ ok, item, created, deduplicated }`
- `DELETE /api/media/{id}`
- `GET /api/media/{id}/file`
- `GET /api/media/{id}/convert?format=mp3|mp4|wav|flac|ogg|m4a`

### Audit / SSE / Suggestions

- `GET /api/events?limit=200&event_type=...&q=...`
- `GET /api/events/stream?replay=30` (SSE)
- `GET /api/suggestions?feature_id=...&field_name=...&limit=...`

## Persistance locale

Le backend persiste les états dans `CosyVoice/api_output/_state/`:

- `history.json`
- `media.json`
- `suggestions.json`
- `audit_events.jsonl`

## Variables d'environnement (SSOT stricte)

Le backend charge obligatoirement la configuration depuis:

`/Users/usernamap/Documents/dev_pers/voice-generation-control-interface/config/ssot.env`

Clés requises:

- `COSYVOICE_MODEL_DIR`
- `COSYVOICE_API_OUTPUT_DIR`
- `COSYVOICE_API_HISTORY_SIZE`
- `COSYVOICE_API_AUDIT_SIZE`
- `COSYVOICE_API_SUGGESTIONS_PER_FIELD`
- `COSYVOICE_API_MAX_UPLOAD_BYTES`
- `COSYVOICE_API_HOST`
- `COSYVOICE_API_PORT`
- `COSYVOICE_CORS_ORIGINS`
- `TOKENIZERS_PARALLELISM`

Il n'y a pas de fallback implicite.

## Déduplication média (SHA-256)

- L'import média applique une déduplication stricte globale sur le hash SHA-256 du contenu audio.
- Si le même fichier est importé plusieurs fois (même contenu), le backend réutilise le même `media_id`:
  - `created=true`, `deduplicated=false` sur première création
  - `created=false`, `deduplicated=true` sur les imports suivants
- Le `kind` n'affecte pas la clé de déduplication (hash uniquement).
- Si `label` est vide, un label auto auditable est généré (`kind + date + nom + hash court`).

## Conversion media

La conversion mp3/mp4/etc. s'appuie sur `ffmpeg`.
Si `ffmpeg` n'est pas installé, l'API retourne une erreur explicite.

## Frontend Next.js

```bash
cd /Users/usernamap/Documents/dev_pers/voice-generation-control-interface
make dev-frontend
```

UI: `http://127.0.0.1:3000`
