# CosyVoice Frontend (Next.js 16)

Control surface moderne pour l'API Python CosyVoice.

## Fonctionnalités UI

- Generation Studio piloté par `GET /api/capabilities` (SSOT)
- Dashboard KPI piloté par `GET /api/stats` + `GET /api/health`
- Suggestions par champ basées sur l'historique d'inputs (`/api/suggestions`)
- Bibliothèque média (CRUD) pour prompts/sources audio
- Conversion directe des sorties et médias (mp3/mp4/wav/flac/ogg/m4a)
- Flux temps réel SSE + timeline d'audit (`/api/events/stream`)
- Persistance locale du store UI (API target, feature active, drafts de formulaires)
- Filtres recherche avancés sur History/Media/Audit
- Export JSON des listes filtrées
- Reset local state (nettoyage des drafts et filtres)

## Run

```bash
cd /Users/usernamap/Documents/dev_pers/t/frontend
npm install
cp .env.local.example .env.local
npm run dev
```

Open: `http://localhost:3000`

## Backend URL

Par défaut le frontend cible:

`http://127.0.0.1:8000`

Vous pouvez changer via `.env.local`:

```bash
NEXT_PUBLIC_API_BASE=http://127.0.0.1:8000
```

## Quality checks

```bash
npm run lint
npm run build
```
