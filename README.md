# Voice Generation Control Interface (Monorepo)

Ce monorepo contient:
- `CosyVoice` (backend Python/FastAPI)
- `frontend` (Next.js)

## Commandes centralisees (depuis la racine)

```bash
make help
```

Commandes principales:

```bash
make install        # installe backend + frontend
make dev            # lance backend + frontend ensemble
make dev-backend    # lance uniquement l'API backend
make dev-frontend   # lance uniquement le frontend
make lint           # checks backend + lint frontend
make build          # build frontend
```

Port/host backend override:

```bash
make dev-backend API_PORT=8001
make dev API_PORT=8001
```

## URLs locales

- Backend API: `http://127.0.0.1:8000/docs`
- Frontend: `http://localhost:3000`
