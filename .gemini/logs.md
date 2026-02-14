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

## 2026-02-14 (gitlink CosyVoice + orchestration racine)
- Diagnostic gitlink confirmé:
  - `CosyVoice` indexé en mode `160000` dans le dépôt parent.
  - absence de mapping `.gitmodules` côté parent.
  - présence de dépôts imbriqués dans `CosyVoice/.git` et `CosyVoice/third_party/Matcha-TTS/.git`.
- Conversion vers dossier normal:
  - suppression de l'entrée index via `git update-index --force-remove CosyVoice`.
  - retrait des métadonnées Git imbriquées (moved hors repo) puis `git add -A CosyVoice`.
  - vérification: plus aucun `160000` pour `CosyVoice`.
- Nettoyage index:
  - exclusion de `CosyVoice/.venv/` via `CosyVoice/.gitignore`.
  - validation qu'aucun fichier `.venv` n'est staged.
- Centralisation monorepo:
  - ajout `Makefile` racine (`install`, `dev`, `dev-backend`, `dev-frontend`, `lint`, `build`).
  - ajout `scripts/dev-all.sh` (backend + frontend en parallèle, cleanup sur arrêt).
  - ajout `README.md` racine (guide des commandes centralisées).
- Validations de la couche racine:
  - `bash -n scripts/dev-all.sh` OK.
  - `make help` OK.
  - `make lint-backend` OK.
  - `make lint-frontend` OK.
  - `make build` OK.

## 2026-02-14 (hotfix make install)
- Incident reporté: `make install` échouait avec `/bin/bash: pip: command not found`.
- Correctif appliqué dans `Makefile`:
  - remplacement du flux `source .venv/bin/activate && pip ...` par
    `$(BACKEND_DIR)/.venv/bin/python -m pip ...`.
  - ajout `python -m ensurepip --upgrade` en fallback de robustesse.
- Validations:
  - `make install-backend` OK.
  - `make install` (backend + frontend) OK.

## 2026-02-14 (diagnostic crash backend dev)
- Reproduction: `make dev-backend` se termine par `address already in use`.
- Diagnostic chirurgical:
  - `lsof -nP -iTCP:8000 -sTCP:LISTEN` retourne un process Python actif (PID 7913).
  - conclusion: conflit de port local, pas de crash logique de l'application.
- Correctif non-régressif:
  - `Makefile`:
    - ajout `API_HOST`/`API_PORT` (defaults `127.0.0.1` / `8000`).
    - précheck de port avant démarrage backend avec message explicite.
  - `scripts/dev-all.sh`:
    - précheck de port backend.
    - propagation `COSYVOICE_API_HOST`/`COSYVOICE_API_PORT`.
  - `README.md`:
    - doc d'override (`make dev-backend API_PORT=8001`, `make dev API_PORT=8001`).
- Validations:
  - `make dev-backend` (port 8000 occupé) => erreur claire + process affiché + action suggérée.
  - `make dev-backend API_PORT=8001` => démarrage backend OK (`Uvicorn running on http://127.0.0.1:8001`).
  - `make dev` (port 8000 occupé) => arrêt immédiat avec diagnostic explicite avant lancement des services.
- Ajustement inclus:
  - `CosyVoice/webui.py` garde un port par défaut séparé (`3008`) pour limiter les collisions locales.

## 2026-02-14 (SSOT ports/URLs/paths sans fallback)
- Création source unique:
  - `config/ssot.env` centralise ports, URLs, paths, limites runtime.
  - `scripts/load-ssot-env.sh` valide les clés requises et exporte l'environnement.
- Refactor orchestration:
  - `Makefile` inclut `config/ssot.env` et supprime les defaults implicites.
  - `scripts/dev-all.sh` charge SSOT et lance backend/frontend avec ces valeurs.
- Refactor backend:
  - ajout `CosyVoice/api_server/ssot.py` (loader + validation stricte).
  - `CosyVoice/tools/run_api_server.py` migre vers `require_env` / `require_int_env`.
  - `CosyVoice/api_server/main.py` migre vers SSOT strict pour model dir, output dir, tailles, CORS, tokenizer.
- Refactor frontend:
  - `frontend/src/app/page.tsx` supprime fallback `http://127.0.0.1:8000` et exige `NEXT_PUBLIC_API_BASE`.
- Docs:
  - `README.md`, `frontend/README.md`, `CosyVoice/README_API.md` alignés SSOT.
- Validations:
  - `bash -n scripts/load-ssot-env.sh` OK.
  - `bash -n scripts/dev-all.sh` OK.
  - `make help` OK.
  - `make check-ssot` OK.
  - `make lint-backend` OK.
  - `make lint-frontend` OK.
  - `make build-frontend` OK.
  - `make dev-backend` (port 8000 occupé) => diagnostic clair + action (éditer `config/ssot.env`).
