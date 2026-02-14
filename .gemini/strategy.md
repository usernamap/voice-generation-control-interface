# Strategy

## Objective
Transformer `CosyVoice` en dossier versionné normal (pas gitlink/blob) et centraliser l'exécution backend/frontend depuis la racine du monorepo.

## Plan
1. [x] Retirer le gitlink `CosyVoice` de l'index parent et l'ajouter comme dossier standard suivi fichier par fichier.
2. [x] Ajouter une orchestration racine claire pour backend/frontend (dev, lint, build, setup).
3. [x] Documenter le nouveau flux d'exécution à la racine.
4. [x] Mettre à jour la mémoire `.gemini` (context, logs, decisions) et vérifier le résultat.

## Assumptions
- Backend principal piloté depuis `CosyVoice/tools/run_api_server.py`.
- Frontend principal piloté depuis `frontend/package.json`.
- La centralisation se fera sans casser les commandes existantes dans chaque sous-projet.

## Hotfix 2026-02-14
1. [x] Corriger `install-backend` pour éviter la dépendance à `pip` global.
2. [x] Valider `make install-backend`.
3. [x] Valider `make install` complet (backend + frontend).

## Hotfix 2026-02-14 (port conflit dev)
1. [x] Diagnostiquer le crash backend au lancement `make dev-backend`.
2. [x] Ajouter un précheck de port clair côté `Makefile` et `scripts/dev-all.sh`.
3. [x] Ajouter le support d'override `API_HOST`/`API_PORT` sans changer le défaut `127.0.0.1:8000`.
4. [x] Valider le chemin d'erreur (port occupé) et le chemin de succès (`API_PORT=8001`).
