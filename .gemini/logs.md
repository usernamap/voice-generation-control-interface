# Logs

## 2026-02-13
- Scan initial du workspace.
- Vérification environnement (OS, Python, ffmpeg, outils).
- Initialisation documentation dynamique `.gemini`.
- Clonage du dépôt officiel `FunAudioLLM/CosyVoice` et init du submodule `third_party/Matcha-TTS`.
- Installation `python@3.10`, création du venv, installation des dépendances CosyVoice.
- Contournement des erreurs d'installation:
  - `openai-whisper` installé avec `--no-build-isolation`.
  - `pyworld==0.3.4` incompatible macOS arm64 -> installation `pyworld==0.3.5`.
- Téléchargement du modèle `FunAudioLLM/Fun-CosyVoice3-0.5B-2512`.
- Test end-to-end réussi: génération `CosyVoice/outputs/test_zero_shot.wav`.

## 2026-02-14 (backend/frontend)
- Implémentation backend FastAPI unifié dans `CosyVoice/api_server/main.py`.
- Ajout registre SSOT des fonctionnalités via `GET /api/capabilities`.
- Création frontend `Next.js 16` dans `frontend/`.
- Refactor UX one-page avec SSE, historique enrichi, suggestions, media CRUD/conversion.

## 2026-02-14 (consolidation moderne)
- Backend renforcé:
  - endpoint consolidé `GET /api/stats`.
  - filtres/recherche/limit sur `GET /api/history`, `GET /api/media`, `GET /api/events`.
  - filtres et limite sur `GET /api/suggestions`.
  - hardening upload avec limite configurable `COSYVOICE_API_MAX_UPLOAD_BYTES`.
  - enrichissement metadata `platform` dans `GET /api/capabilities`.
- Frontend renforcé:
  - intégration santé/stats backend.
  - dashboard KPI en tête de page.
  - filtres recherche et sélection de type/feature sur Media, History, Audit.
  - export JSON des listes filtrées (history/media/audit).
  - reset du store local UI.

## 2026-02-14 (warnings + auto-media + dark refactor)
- Suppression warning SDPA sliding-window:
  - `cosyvoice/llm/llm.py` ajuste le chargement Qwen2 (`attn_implementation=eager` par défaut + override env + neutralisation sliding window inactive).
- Suppression warning `weight_norm`:
  - migration vers `torch.nn.utils.parametrizations.weight_norm` avec fallback dans:
    - `third_party/Matcha-TTS/matcha/hifigan/models.py`
    - `third_party/Matcha-TTS/matcha/hifigan/xutils.py`
- Réduction dépendance runtime à Lightning:
  - lazy exports dans `third_party/Matcha-TTS/matcha/utils/__init__.py`
  - fallback sans lightning dans `pylogger.py`, `logging_utils.py`, `rich_utils.py`
  - filtre warning ciblé `pkg_resources` dans `tools/run_api_server.py`
  - filtre ciblé import `pyworld` dans `cosyvoice/dataset/processor.py`
- Backend média:
  - helpers SHA-256, auto-label, upsert média, backfill hash au startup.
  - déduplication globale stricte par contenu.
  - extension réponse `POST /api/media` -> `{created, deduplicated}`.
  - nouvel événement audit `media_deduplicated`.
- Frontend:
  - auto-import média sur sélection fichier en Studio/Speaker/Media.
  - auto-association du `media_id` importé.
  - feedback explicite doublon.
  - placeholders média avec compteur disponible.
  - extension type `MediaCreateResponse` (`created`, `deduplicated`).
  - thème dark global modernisé + cursor pointer global.
- Documentation:
  - `CosyVoice/README_API.md` mis à jour (origin, created/deduplicated, stratégie de déduplication).

## Validations
- `python3 -m py_compile CosyVoice/api_server/main.py` OK.
- `python3 -m py_compile` sur fichiers backend modifiés (llm/matcha/utils/processor) OK.
- `cd frontend && npm run lint` OK.
- `cd frontend && npm run build` OK.
- Test API déduplication:
  - import #1 => `created=true`, `deduplicated=false`
  - import #2 même contenu => `created=false`, `deduplicated=true`, même `media_id`
