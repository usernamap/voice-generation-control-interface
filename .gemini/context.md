# Context

- Repository de travail initialement vide (hors `.git`).
- Système: macOS arm64.
- Python 3.10 + venv `CosyVoice/.venv` utilisés pour runtime CosyVoice.
- Modèle local actif: `Fun-CosyVoice3-0.5B`.

## Etat actuel (cible active)

### Backend CosyVoice API

- API FastAPI unifiée dans `CosyVoice/api_server/main.py`.
- Fonctionnalités actives:
  - SSOT capabilities (`GET /api/capabilities`).
  - stats consolidées (`GET /api/stats`).
  - génération multi-features (`POST /api/generate/{feature_id}`).
  - speakers (`/api/speakers*`).
  - historique + audio + clear (`/api/history*`) avec filtres/recherche/limit.
  - media CRUD + conversion (`/api/media*`, `/api/history/{id}/convert`) avec filtres/recherche/limit.
  - audit events + SSE (`/api/events`, `/api/events/stream`) avec filtres/recherche/limit.
  - suggestions de saisie (`/api/suggestions`) avec filtre de champ et limite.
- Hardening:
  - limite upload configurable via `COSYVOICE_API_MAX_UPLOAD_BYTES`.
  - ingestion média centralisée avec hash SHA-256 + déduplication globale.
  - backfill `content_hash` au startup pour médias historiques.
  - auto-label média si label absent (`kind + date + nom + hash court`).
  - `POST /api/media` retourne `created` + `deduplicated`.
  - nouvel événement audit `media_deduplicated`.
- Runtime warnings:
  - warning SDPA sliding-window supprimé via `Qwen2Encoder` (`attn_implementation=eager` par défaut).
  - warning `weight_norm` supprimé via parametrizations + fallback robuste.
  - warning `pkg_resources` neutralisé côté lancement API (`tools/run_api_server.py`) et dépendances Matcha allégées.
- Persistance locale: `CosyVoice/api_output/_state/`.

### Frontend Next.js

- UI principale dans `frontend/src/app/page.tsx`.
- Sections Studio/Media/Historique/Audit.
- Dashboard KPI (stats backend + état modèle).
- Filtres recherche (history/media/audit) + export JSON.
- Store persistant local + reset local state.
- Consommation SSE + suggestions par champ.
- Flux média auto-import:
  - import immédiat sur sélection fichier en Studio/Speaker/Media.
  - auto-association `media_id` au champ concerné.
  - feedback explicite en cas de doublon (`deduplicated=true`).
  - placeholder sélecteur média avec compteur disponible.
- UI/UX:
  - thème dark modernisé dans `frontend/src/app/globals.css`.
  - curseur pointer généralisé pour éléments interactifs.

## Validation technique

- `python3 -m py_compile CosyVoice/api_server/main.py` OK.
- `python3 -m py_compile CosyVoice/cosyvoice/llm/llm.py` OK.
- `npm run lint` (frontend) OK.
- `npm run build` (frontend) OK.
- `./.venv/bin/python tools/run_api_server.py` démarre sans warnings SDPA/weight_norm/pkg_resources visibles.

## Mise a jour monorepo (2026-02-14)

- `CosyVoice` est maintenant versionne comme dossier standard dans le depot parent (fin du gitlink `160000`).
- Les depots Git imbriques (`CosyVoice/.git`, `CosyVoice/third_party/Matcha-TTS/.git`) ont ete retires du workspace pour eviter le mode sous-module implicite.
- Le venv local backend reste non versionne via `.venv/` ajoute dans `CosyVoice/.gitignore`.
- Une orchestration racine est disponible:
  - `Makefile` a la racine (`install`, `dev`, `dev-backend`, `dev-frontend`, `lint`, `build`).
  - script `scripts/dev-all.sh` pour demarrage backend + frontend en parallele avec arret propre.
  - `README.md` racine documentant les commandes centralisees.
- Hotfix installation:
  - `install-backend` utilise desormais `CosyVoice/.venv/bin/python -m pip` (plus de dependance a `pip` global).
  - `make install` est confirme fonctionnel sur la machine locale.
- Hotfix lancement backend:
  - le crash observe n'etait pas applicatif: `127.0.0.1:8000` etait deja occupe.
  - `make dev-backend` et `make dev` effectuent maintenant un precheck de port et affichent un diagnostic actionnable.
  - override disponible: `API_HOST`, `API_PORT` (ex: `make dev-backend API_PORT=8001`).
  - `CosyVoice/webui.py` conserve un port par defaut distinct (`3008`) pour eviter un chevauchement avec l'API (`8000`).
