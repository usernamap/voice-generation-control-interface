# Strategy

## Objective
Implémenter la correction complète demandée: suppression des warnings runtime, ingestion média auto avec déduplication stricte SHA-256, et refonte frontend dark/UX moderne sans rupture API.

## Plan
1. [x] Corriger warnings backend au démarrage (Qwen2 attention, Matcha lazy import, weight_norm modernisé).
2. [x] Implémenter couche média backend centralisée (hash, auto-label, upsert, backfill, événements dedupe).
3. [x] Adapter frontend auto-import média (Studio/Speaker/Media), UX dedupe explicite, compteurs et sync.
4. [x] Refonte dark UI/UX + cursor pointer global + optimisation de rendu côté React.
5. [x] Mettre à jour README_API et mémoire `.gemini`, puis valider (py_compile, lint, build, run API).

## Assumptions
- Déduplication globale stricte sur hash SHA-256 (indépendante du kind).
- Qwen2 forcé en `attn_implementation=eager` par défaut, override via `COSYVOICE_QWEN_ATTN_IMPL`.
- Backward compatibility stricte des endpoints existants.
