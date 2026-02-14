# Decisions

## ADR-001: Utiliser un environnement Python isolé
- Décision: créer un venv dédié au projet pour éviter les conflits de versions.
- Raison: Python système 3.14 risque d'être incompatible avec certaines dépendances ML (PyTorch/CosyVoice).

## ADR-002: Adapter les dépendances pour macOS arm64
- Décision: utiliser `requirements.macos.inference.txt` + `pip install --no-build-isolation`.
- Raison: l'installation standard échouait sur `openai-whisper` en build isolation.

## ADR-003: Utiliser `pyworld==0.3.5` au lieu de `0.3.4`
- Décision: installer `pyworld==0.3.5` pour runtime local.
- Raison: `pyworld==0.3.4` ne compile pas correctement sur l'environnement macOS arm64 testé.

## ADR-004: Backend unifié piloté par registre SSOT
- Décision: implémenter un endpoint central `GET /api/capabilities` pour décrire dynamiquement toutes les features disponibles selon le type de modèle actif.
- Raison: éviter la duplication backend/frontend et garantir une source unique de vérité.

## ADR-005: Frontend one-page orienté orchestration
- Décision: construire une page riche consommant le registre SSOT backend.
- Raison: centraliser l'expérience utilisateur et couvrir les cas d'usage sans navigation multi-pages.

## ADR-006: Persistance locale JSON/JSONL pour auditabilité immédiate
- Décision: persister history/media/suggestions/events dans `api_output/_state/`.
- Raison: fournir durabilité et traçabilité sans introduire immédiatement une base externe.

## ADR-007: Ajouter un bus d'événements SSE natif backend
- Décision: exposer `GET /api/events` + `GET /api/events/stream` avec replay des derniers événements.
- Raison: fournir observabilité temps réel pour UX live et audit opérationnel.

## ADR-008: Introduire une media library CRUD + conversion backend
- Décision: implémenter `GET/POST/DELETE /api/media*` et conversion multi-format via `ffmpeg`.
- Raison: réutilisation des prompts/sources audio, réduction des re-uploads, export multi-format.

## ADR-009: Store UI persistant localStorage
- Décision: conserver état utilisateur (feature active, drafts, mapping média, API target) côté frontend.
- Raison: fluidifier l'usage quotidien et réduire les saisies répétitives.

## ADR-010: Support media reference dans endpoints métier
- Décision: accepter `prompt_wav_media_id` et `<audio_field>_media_id` dans le backend.
- Raison: permettre des workflows media-first sans upload redondant depuis l'UI.

## ADR-011: Périmètre final simplifié
- Décision: maintenir uniquement le backend Python et le frontend Next.js.
- Raison: alignement strict sur le besoin actuel et réduction de complexité opérationnelle.

## ADR-012: Hardening API et UX avancée sans dépendance externe
- Décision: ajouter stats backend, filtres/recherche, limite upload, exports JSON et réinitialisation locale.
- Raison: améliorer nettement l'exploitabilité quotidienne sans introduire de stack additionnelle.

## ADR-013: Déduplication média globale par hash SHA-256
- Décision: introduire une clé de déduplication globale `content_hash` indépendante du `kind`.
- Raison: empêcher les doublons binaires, stabiliser les références média et réduire l'espace disque.

## ADR-014: Contrat API média enrichi et backward-compatible
- Décision: étendre `POST /api/media` avec `origin` en entrée et `created`/`deduplicated` en sortie.
- Raison: tracer l'origine des imports et offrir un feedback exact au frontend sans casser les clients existants.

## ADR-015: Politique attention Qwen2 stable pour inférence locale
- Décision: forcer `attn_implementation=eager` par défaut (override via `COSYVOICE_QWEN_ATTN_IMPL`) et neutraliser sliding-window inactive.
- Raison: supprimer les warnings SDPA et stabiliser le comportement d'inférence sur environnement local CPU/macOS.

## ADR-016: Compatibilité weight norm multi-versions torch
- Décision: migrer vers `torch.nn.utils.parametrizations.weight_norm` avec fallback legacy + remove robuste.
- Raison: supprimer warning de dépréciation sans casser la compatibilité des modèles tiers.
