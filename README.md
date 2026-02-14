# Voice Generation Control Interface (Monorepo)

Ce monorepo contient:
- `CosyVoice` (backend Python/FastAPI)
- `frontend` (Next.js)

## SSOT configuration

La source unique de vérité est:

`config/ssot.env`

Ce fichier centralise ports, URLs, paths et paramètres runtime.
Aucune valeur par défaut implicite n'est utilisée dans l'orchestration monorepo.

## Commandes centralisees (depuis la racine)

```bash
make help
```

Commandes principales:

```bash
make install        # installe backend + frontend
make check-ssot     # valide la config SSOT
make dev            # lance backend + frontend ensemble
make dev-backend    # lance uniquement l'API backend
make dev-frontend   # lance uniquement le frontend
make dev-webui      # lance la WebUI CosyVoice
make lint           # checks backend + lint frontend
make build          # build frontend
```

## Changer ports/URLs/paths

```bash
# Editer la source unique:
$EDITOR config/ssot.env
```

## URLs locales

- Backend API: `http://127.0.0.1:8000/docs`
- Frontend: `http://127.0.0.1:3000`
