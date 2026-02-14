"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AuditEvent,
  AuditEventsResponse,
  CapabilitiesResponse,
  FeatureField,
  FeatureSpec,
  GenerateResponse,
  HealthResponse,
  HistoryItem,
  HistoryResponse,
  MediaCreateResponse,
  MediaItem,
  MediaResponse,
  SpeakerListResponse,
  StatsResponse,
  SuggestionEntry,
  SuggestionsResponse,
  buildApiUrl,
  parseApiResponse,
} from "@/lib/cosyvoice-api";

type FormValue = string | number | boolean;
type MediaKind = "prompt" | "source" | "generic";
type TabId = "studio" | "media" | "history" | "audit";
type SseStatus = "connecting" | "connected" | "disconnected";

type StoredState = {
  apiBase: string;
  selectedFeatureId: string;
  activeTab: TabId;
  draftsByFeature: Record<string, Record<string, FormValue>>;
  mediaByFeature: Record<string, Record<string, string>>;
};

const configuredApiBase = process.env.NEXT_PUBLIC_API_BASE;
if (!configuredApiBase) {
  throw new Error("Missing NEXT_PUBLIC_API_BASE. Load config/ssot.env before starting frontend.");
}
const DEFAULT_API_BASE = configuredApiBase;
const STORAGE_KEY = "cosyvoice.control.v2";
const MAX_AUDIT_UI_ITEMS = 300;
const FALLBACK_CONVERSION_FORMATS = ["wav", "mp3", "flac", "ogg", "m4a", "mp4"];

const EVENT_TYPES = [
  "server_started",
  "model_reloaded",
  "speakers_saved",
  "speaker_added",
  "history_cleared",
  "media_created",
  "media_deduplicated",
  "media_deleted",
  "media_converted",
  "generation_started",
  "generation_completed",
  "generation_failed",
] as const;

function defaultStoredState(): StoredState {
  return {
    apiBase: DEFAULT_API_BASE,
    selectedFeatureId: "",
    activeTab: "studio",
    draftsByFeature: {},
    mediaByFeature: {},
  };
}

function loadStoredState(): StoredState {
  if (typeof window === "undefined") {
    return defaultStoredState();
  }
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return defaultStoredState();
  }

  try {
    const parsed = JSON.parse(raw) as Partial<StoredState>;
    const base = defaultStoredState();
    return {
      apiBase: typeof parsed.apiBase === "string" && parsed.apiBase.trim() ? parsed.apiBase : base.apiBase,
      selectedFeatureId:
        typeof parsed.selectedFeatureId === "string" && parsed.selectedFeatureId.trim() ? parsed.selectedFeatureId : "",
      activeTab:
        parsed.activeTab === "studio" || parsed.activeTab === "media" || parsed.activeTab === "history" || parsed.activeTab === "audit"
          ? parsed.activeTab
          : "studio",
      draftsByFeature: parsed.draftsByFeature && typeof parsed.draftsByFeature === "object" ? parsed.draftsByFeature : {},
      mediaByFeature: parsed.mediaByFeature && typeof parsed.mediaByFeature === "object" ? parsed.mediaByFeature : {},
    };
  } catch {
    return defaultStoredState();
  }
}

function fieldDefaultValue(field: FeatureField): FormValue {
  if (field.default !== undefined) {
    return field.default;
  }
  if (field.type === "boolean") {
    return false;
  }
  if (field.type === "number") {
    return 1;
  }
  return "";
}

function toPayloadValue(field: FeatureField, value: FormValue | undefined): FormValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (field.type === "number") {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : undefined;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  if (field.type === "boolean") {
    return Boolean(value);
  }

  const text = String(value).trim();
  return text.length ? text : undefined;
}

function prettyDate(raw: string): string {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return raw;
  }
  return date.toLocaleString();
}

function prettyDuration(seconds: number): string {
  return `${seconds.toFixed(2)}s`;
}

function prettyBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

function downloadJson(filename: string, payload: unknown): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function isoDateForFilename(): string {
  return new Date().toISOString().replaceAll(":", "-");
}

function fieldHint(field: FeatureField): string {
  if (field.type === "textarea") {
    return "Champ texte long. Conservez un wording stable pour de meilleurs résultats reproductibles.";
  }
  if (field.type === "number") {
    return "Valeur numérique. Exemple: 1.0 = vitesse nominale.";
  }
  if (field.type === "boolean") {
    return "Option binaire. Activez seulement si nécessaire à votre cas.";
  }
  return "Texte libre. Les suggestions proviennent de votre historique d exécution.";
}

function isAuditEvent(value: unknown): value is AuditEvent {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<AuditEvent>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.type === "string" &&
    typeof candidate.created_at === "string" &&
    Boolean(candidate.payload) &&
    typeof candidate.payload === "object"
  );
}

function stringPreview(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}

function mediaKindFromField(fieldName: string): MediaKind {
  const lower = fieldName.toLowerCase();
  if (lower.includes("prompt")) {
    return "prompt";
  }
  if (lower.includes("source")) {
    return "source";
  }
  return "generic";
}

export default function Home() {
  const persisted = useMemo(loadStoredState, []);

  const [apiBase, setApiBase] = useState(persisted.apiBase || DEFAULT_API_BASE);
  const [capabilities, setCapabilities] = useState<CapabilitiesResponse | null>(null);
  const [selectedFeatureId, setSelectedFeatureId] = useState<string>(persisted.selectedFeatureId);
  const [activeTab, setActiveTab] = useState<TabId>(persisted.activeTab);

  const [draftsByFeature, setDraftsByFeature] = useState<Record<string, Record<string, FormValue>>>(
    persisted.draftsByFeature
  );
  const [mediaByFeature, setMediaByFeature] = useState<Record<string, Record<string, string>>>(persisted.mediaByFeature);

  const draftsRef = useRef(draftsByFeature);
  const mediaRef = useRef(mediaByFeature);

  const [fieldValues, setFieldValues] = useState<Record<string, FormValue>>({});
  const [audioFiles, setAudioFiles] = useState<Record<string, File | null>>({});
  const [audioMediaRefs, setAudioMediaRefs] = useState<Record<string, string>>({});

  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [speakerIds, setSpeakerIds] = useState<string[]>([]);
  const [mediaItems, setMediaItems] = useState<MediaItem[]>([]);
  const [suggestionsByFeature, setSuggestionsByFeature] = useState<Record<string, Record<string, SuggestionEntry[]>>>({});
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [stats, setStats] = useState<StatsResponse | null>(null);

  const [latestResult, setLatestResult] = useState<GenerateResponse | null>(null);

  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [sseStatus, setSseStatus] = useState<SseStatus>("connecting");

  const [reloadModelDir, setReloadModelDir] = useState("");
  const [speakerPromptText, setSpeakerPromptText] = useState("");
  const [speakerIdToAdd, setSpeakerIdToAdd] = useState("");
  const [speakerPromptFile, setSpeakerPromptFile] = useState<File | null>(null);
  const [speakerPromptMediaId, setSpeakerPromptMediaId] = useState("");

  const [mediaUploadFile, setMediaUploadFile] = useState<File | null>(null);
  const [mediaUploadLabel, setMediaUploadLabel] = useState("");
  const [mediaUploadKind, setMediaUploadKind] = useState<MediaKind>("generic");
  const [autoImportingFields, setAutoImportingFields] = useState<Record<string, boolean>>({});
  const [autoImportingSpeaker, setAutoImportingSpeaker] = useState(false);
  const [autoImportingMedia, setAutoImportingMedia] = useState(false);

  const [historyQuery, setHistoryQuery] = useState("");
  const [historyFeatureFilter, setHistoryFeatureFilter] = useState("all");
  const [mediaQuery, setMediaQuery] = useState("");
  const [mediaKindFilter, setMediaKindFilter] = useState<"all" | MediaKind>("all");
  const [auditQuery, setAuditQuery] = useState("");
  const [auditTypeFilter, setAuditTypeFilter] = useState("all");

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const busy = busyAction !== null;

  const selectedFeature = useMemo<FeatureSpec | null>(() => {
    if (!capabilities) {
      return null;
    }
    return capabilities.features.find((feature) => feature.id === selectedFeatureId) ?? null;
  }, [capabilities, selectedFeatureId]);

  const selectedSuggestions = useMemo<Record<string, SuggestionEntry[]>>(() => {
    if (!selectedFeature) {
      return {};
    }
    return suggestionsByFeature[selectedFeature.id] ?? {};
  }, [selectedFeature, suggestionsByFeature]);

  const filteredHistoryItems = useMemo<HistoryItem[]>(() => {
    return historyItems.filter((item) => {
      if (historyFeatureFilter !== "all" && item.feature_id !== historyFeatureFilter) {
        return false;
      }
      if (!historyQuery.trim()) {
        return true;
      }
      const needle = historyQuery.trim().toLowerCase();
      return (
        item.id.toLowerCase().includes(needle) ||
        item.feature_id.toLowerCase().includes(needle) ||
        JSON.stringify(item.inputs_preview).toLowerCase().includes(needle)
      );
    });
  }, [historyFeatureFilter, historyItems, historyQuery]);

  const filteredMediaItems = useMemo<MediaItem[]>(() => {
    return mediaItems.filter((item) => {
      if (mediaKindFilter !== "all" && item.kind !== mediaKindFilter) {
        return false;
      }
      if (!mediaQuery.trim()) {
        return true;
      }
      const needle = mediaQuery.trim().toLowerCase();
      return (
        item.id.toLowerCase().includes(needle) ||
        item.label.toLowerCase().includes(needle) ||
        item.original_name.toLowerCase().includes(needle)
      );
    });
  }, [mediaItems, mediaKindFilter, mediaQuery]);

  const auditEventTypes = useMemo<string[]>(() => {
    return Array.from(new Set(auditEvents.map((event) => event.type))).sort((a, b) => a.localeCompare(b));
  }, [auditEvents]);

  const filteredAuditEvents = useMemo<AuditEvent[]>(() => {
    return auditEvents.filter((event) => {
      if (auditTypeFilter !== "all" && event.type !== auditTypeFilter) {
        return false;
      }
      if (!auditQuery.trim()) {
        return true;
      }
      const needle = auditQuery.trim().toLowerCase();
      return (
        event.id.toLowerCase().includes(needle) ||
        event.type.toLowerCase().includes(needle) ||
        JSON.stringify(event.payload).toLowerCase().includes(needle)
      );
    });
  }, [auditEvents, auditQuery, auditTypeFilter]);

  const conversionFormats =
    capabilities?.platform?.supported_conversions && capabilities.platform.supported_conversions.length
      ? capabilities.platform.supported_conversions
      : FALLBACK_CONVERSION_FORMATS;

  const maxUploadMb = useMemo(() => {
    const raw = capabilities?.platform?.max_upload_bytes;
    if (!raw || !Number.isFinite(raw)) {
      return null;
    }
    return (raw / (1024 * 1024)).toFixed(1);
  }, [capabilities?.platform?.max_upload_bytes]);

  const modelInfo = capabilities?.model ?? null;

  const apiUrl = useCallback(
    (path: string) => {
      return buildApiUrl(apiBase, path);
    },
    [apiBase]
  );

  const appendAuditEvent = useCallback((event: AuditEvent): void => {
    setAuditEvents((previous) => [event, ...previous].slice(0, MAX_AUDIT_UI_ITEMS));
  }, []);

  const refreshCapabilities = useCallback(async (): Promise<void> => {
    const response = await fetch(apiUrl("/api/capabilities"));
    const data = await parseApiResponse<CapabilitiesResponse>(response);
    setCapabilities(data);
    setReloadModelDir(data.model.model_dir);
    setSelectedFeatureId((current) => {
      if (current && data.features.some((feature) => feature.id === current)) {
        return current;
      }
      return data.features[0]?.id ?? "";
    });
  }, [apiUrl]);

  const refreshHistory = useCallback(async (): Promise<void> => {
    const response = await fetch(apiUrl("/api/history"));
    const data = await parseApiResponse<HistoryResponse>(response);
    setHistoryItems(data.items);
  }, [apiUrl]);

  const refreshSpeakers = useCallback(async (): Promise<void> => {
    const response = await fetch(apiUrl("/api/speakers"));
    const data = await parseApiResponse<SpeakerListResponse>(response);
    setSpeakerIds(data.speakers);
  }, [apiUrl]);

  const refreshMedia = useCallback(async (): Promise<void> => {
    const response = await fetch(apiUrl("/api/media"));
    const data = await parseApiResponse<MediaResponse>(response);
    setMediaItems(data.items);
  }, [apiUrl]);

  const refreshSuggestions = useCallback(async (): Promise<void> => {
    const response = await fetch(apiUrl("/api/suggestions"));
    const data = await parseApiResponse<SuggestionsResponse>(response);
    setSuggestionsByFeature(data.features);
  }, [apiUrl]);

  const refreshHealth = useCallback(async (): Promise<void> => {
    const response = await fetch(apiUrl("/api/health"));
    const data = await parseApiResponse<HealthResponse>(response);
    setHealth(data);
  }, [apiUrl]);

  const refreshStats = useCallback(async (): Promise<void> => {
    const response = await fetch(apiUrl("/api/stats"));
    const data = await parseApiResponse<StatsResponse>(response);
    setStats(data);
  }, [apiUrl]);

  const refreshAuditEvents = useCallback(async (): Promise<void> => {
    const response = await fetch(apiUrl("/api/events?limit=200"));
    const data = await parseApiResponse<AuditEventsResponse>(response);
    setAuditEvents(data.items.reverse());
  }, [apiUrl]);

  const upsertMediaItemLocal = useCallback((item: MediaItem): void => {
    setMediaItems((previous) => {
      const next = [item, ...previous.filter((existing) => existing.id !== item.id)];
      return next.sort((a, b) => b.created_at.localeCompare(a.created_at));
    });
  }, []);

  const loadAll = useCallback(async (): Promise<void> => {
    try {
      setBusyAction("sync");
      setError("");
      setMessage("Synchronisation backend en cours...");
      await Promise.all([
        refreshCapabilities(),
        refreshHistory(),
        refreshSpeakers(),
        refreshMedia(),
        refreshSuggestions(),
        refreshHealth(),
        refreshStats(),
        refreshAuditEvents(),
      ]);
      setMessage("Etat backend synchronisé.");
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Erreur inconnue lors de la synchronisation.";
      setError(detail);
      setMessage("");
    } finally {
      setBusyAction(null);
    }
  }, [refreshAuditEvents, refreshCapabilities, refreshHealth, refreshHistory, refreshMedia, refreshSpeakers, refreshStats, refreshSuggestions]);

  const handleAuditEvent = useCallback(
    (event: AuditEvent): void => {
      appendAuditEvent(event);

      if (event.type === "generation_completed" || event.type === "history_cleared") {
        void refreshHistory();
      }
      if (event.type === "generation_completed") {
        void refreshSuggestions();
      }
      if (
        event.type === "generation_completed" ||
        event.type === "history_cleared" ||
        event.type === "media_created" ||
        event.type === "media_deduplicated" ||
        event.type === "media_deleted" ||
        event.type === "speaker_added" ||
        event.type === "speakers_saved" ||
        event.type === "model_reloaded"
      ) {
        void refreshStats();
      }
      if (event.type === "speaker_added" || event.type === "speakers_saved") {
        void refreshSpeakers();
      }
      if (event.type === "media_created" || event.type === "media_deduplicated" || event.type === "media_deleted") {
        void refreshMedia();
      }
      if (event.type === "model_reloaded") {
        void refreshCapabilities();
      }
    },
    [appendAuditEvent, refreshCapabilities, refreshHistory, refreshMedia, refreshSpeakers, refreshStats, refreshSuggestions]
  );

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    draftsRef.current = draftsByFeature;
  }, [draftsByFeature]);

  useEffect(() => {
    mediaRef.current = mediaByFeature;
  }, [mediaByFeature]);

  useEffect(() => {
    if (!selectedFeature) {
      return;
    }

    const defaults: Record<string, FormValue> = {};
    for (const field of [...selectedFeature.text_fields, ...selectedFeature.options]) {
      defaults[field.name] = fieldDefaultValue(field);
    }

    const persistedDraft = draftsRef.current[selectedFeature.id] ?? {};
    setFieldValues({ ...defaults, ...persistedDraft });

    const nextFiles: Record<string, File | null> = {};
    for (const audioField of selectedFeature.audio_fields) {
      nextFiles[audioField.name] = null;
    }
    setAudioFiles(nextFiles);

    const mediaDraft = mediaRef.current[selectedFeature.id] ?? {};
    const nextMediaRefs: Record<string, string> = {};
    for (const audioField of selectedFeature.audio_fields) {
      nextMediaRefs[audioField.name] = mediaDraft[audioField.name] ?? "";
    }
    setAudioMediaRefs(nextMediaRefs);

    setError("");
    setMessage("");
  }, [selectedFeature]);

  useEffect(() => {
    const payload: StoredState = {
      apiBase,
      selectedFeatureId,
      activeTab,
      draftsByFeature,
      mediaByFeature,
    };
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
    }
  }, [activeTab, apiBase, draftsByFeature, mediaByFeature, selectedFeatureId]);

  useEffect(() => {
    let source: EventSource | null = null;
    const listeners: Array<{ type: string; handler: (event: MessageEvent<string>) => void }> = [];

    setSseStatus("connecting");

    try {
      source = new EventSource(apiUrl("/api/events/stream?replay=30"));
    } catch {
      setSseStatus("disconnected");
      return () => undefined;
    }

    const receive = (event: MessageEvent<string>): void => {
      if (!event.data) {
        return;
      }
      try {
        const parsed = JSON.parse(event.data) as unknown;
        if (!isAuditEvent(parsed)) {
          return;
        }
        handleAuditEvent(parsed);
      } catch {
        // ignore malformed frames
      }
    };

    const messageHandler = (event: MessageEvent<string>) => receive(event);
    source.addEventListener("message", messageHandler as EventListener);
    listeners.push({ type: "message", handler: messageHandler });

    for (const type of EVENT_TYPES) {
      const handler = (event: MessageEvent<string>) => receive(event);
      source.addEventListener(type, handler as EventListener);
      listeners.push({ type, handler });
    }

    source.onopen = () => {
      setSseStatus("connected");
    };

    source.onerror = () => {
      setSseStatus("disconnected");
    };

    return () => {
      if (!source) {
        return;
      }
      for (const listener of listeners) {
        source.removeEventListener(listener.type, listener.handler as EventListener);
      }
      source.close();
    };
  }, [apiUrl, handleAuditEvent]);

  function updateField(name: string, value: FormValue): void {
    setFieldValues((previous) => {
      const next = { ...previous, [name]: value };
      if (selectedFeatureId) {
        setDraftsByFeature((current) => ({ ...current, [selectedFeatureId]: next }));
      }
      return next;
    });
  }

  function updateAudio(name: string, file: File | null): void {
    setAudioFiles((previous) => ({ ...previous, [name]: file }));
  }

  function updateAudioMedia(name: string, mediaId: string): void {
    setAudioMediaRefs((previous) => {
      const next = { ...previous, [name]: mediaId };
      if (selectedFeatureId) {
        setMediaByFeature((current) => ({ ...current, [selectedFeatureId]: next }));
      }
      return next;
    });
  }

  function applySuggestion(fieldName: string, value: string): void {
    const raw = fieldValues[fieldName];
    if (typeof raw === "number") {
      const parsed = Number(value);
      updateField(fieldName, Number.isFinite(parsed) ? parsed : raw);
      return;
    }
    if (typeof raw === "boolean") {
      updateField(fieldName, value === "true");
      return;
    }
    updateField(fieldName, value);
  }

  function exportHistoryAsJson(): void {
    downloadJson(`cosyvoice-history-${isoDateForFilename()}.json`, filteredHistoryItems);
  }

  function exportMediaAsJson(): void {
    downloadJson(`cosyvoice-media-${isoDateForFilename()}.json`, filteredMediaItems);
  }

  function exportAuditAsJson(): void {
    downloadJson(`cosyvoice-audit-${isoDateForFilename()}.json`, filteredAuditEvents);
  }

  function resetLocalWorkspaceState(): void {
    if (typeof window !== "undefined") {
      window.localStorage.removeItem(STORAGE_KEY);
    }
    const next = defaultStoredState();
    setApiBase(DEFAULT_API_BASE);
    setSelectedFeatureId("");
    setActiveTab(next.activeTab);
    setDraftsByFeature({});
    setMediaByFeature({});
    setHistoryQuery("");
    setHistoryFeatureFilter("all");
    setMediaQuery("");
    setMediaKindFilter("all");
    setAuditQuery("");
    setAuditTypeFilter("all");
    setMessage("Etat local réinitialisé (drafts, filtres, sélection).");
    setError("");
  }

  async function importMediaFile(
    file: File,
    options: {
      kind: MediaKind;
      label?: string;
      origin: string;
      silent?: boolean;
    }
  ): Promise<MediaCreateResponse> {
    const formData = new FormData();
    formData.append(
      "payload",
      JSON.stringify({
        label: options.label?.trim() ?? "",
        kind: options.kind,
        origin: options.origin,
      })
    );
    formData.append("file", file);

    const response = await fetch(apiUrl("/api/media"), {
      method: "POST",
      body: formData,
    });
    const data = await parseApiResponse<MediaCreateResponse>(response);
    upsertMediaItemLocal(data.item);
    await refreshStats();

    if (!options.silent) {
      if (data.deduplicated) {
        setMessage(`Doublon détecté: média existant réutilisé (${data.item.label}).`);
      } else {
        setMessage(`Média importé: ${data.item.label}.`);
      }
      setError("");
    }
    return data;
  }

  async function handleStudioAudioAutoImport(fieldName: string, file: File | null): Promise<void> {
    updateAudio(fieldName, file);
    if (!file) {
      return;
    }

    const key = `studio:${fieldName}`;
    try {
      setAutoImportingFields((previous) => ({ ...previous, [key]: true }));
      const data = await importMediaFile(file, {
        kind: mediaKindFromField(fieldName),
        origin: `studio:${fieldName}`,
      });
      updateAudioMedia(fieldName, data.item.id);
      updateAudio(fieldName, null);
      await refreshMedia();
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Erreur import auto média.";
      setError(detail);
      setMessage("Import auto indisponible: le fichier local sera utilisé comme fallback.");
    } finally {
      setAutoImportingFields((previous) => ({ ...previous, [key]: false }));
    }
  }

  async function handleSpeakerAudioAutoImport(file: File | null): Promise<void> {
    setSpeakerPromptFile(file);
    if (!file) {
      return;
    }

    try {
      setAutoImportingSpeaker(true);
      const data = await importMediaFile(file, {
        kind: "prompt",
        origin: "speaker:prompt_wav",
      });
      setSpeakerPromptMediaId(data.item.id);
      setSpeakerPromptFile(null);
      await refreshMedia();
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Erreur import auto speaker.";
      setError(detail);
      setMessage("Import auto speaker indisponible: fallback fichier local conservé.");
    } finally {
      setAutoImportingSpeaker(false);
    }
  }

  async function handleMediaTabAutoImport(file: File | null): Promise<void> {
    setMediaUploadFile(file);
    if (!file) {
      return;
    }

    try {
      setAutoImportingMedia(true);
      await importMediaFile(file, {
        kind: mediaUploadKind,
        label: mediaUploadLabel,
        origin: "media_tab:file_input",
      });
      setMediaUploadFile(null);
      setMediaUploadLabel("");
      await refreshMedia();
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Erreur import auto média.";
      setError(detail);
      setMessage("Import auto échoué: utilisez le bouton Ajouter pour retry.");
    } finally {
      setAutoImportingMedia(false);
    }
  }

  async function runGeneration(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!selectedFeature) {
      return;
    }

    try {
      setBusyAction("generate");
      setError("");
      setMessage(`Exécution de ${selectedFeature.title}...`);

      const payload: Record<string, unknown> = {};
      for (const field of [...selectedFeature.text_fields, ...selectedFeature.options]) {
        const value = toPayloadValue(field, fieldValues[field.name]);
        if (value !== undefined) {
          payload[field.name] = value;
        }
      }

      for (const audioField of selectedFeature.audio_fields) {
        const mediaId = audioMediaRefs[audioField.name];
        if (mediaId) {
          payload[`${audioField.name}_media_id`] = mediaId;
        }
        if (audioField.required && !audioFiles[audioField.name] && !mediaId) {
          throw new Error(`Champ audio requis manquant: ${audioField.label}`);
        }
      }

      const formData = new FormData();
      formData.append("payload", JSON.stringify(payload));
      for (const audioField of selectedFeature.audio_fields) {
        const file = audioFiles[audioField.name];
        if (file) {
          formData.append(audioField.name, file);
        }
      }

      const response = await fetch(apiUrl(`/api/generate/${selectedFeature.id}`), {
        method: "POST",
        body: formData,
      });
      const data = await parseApiResponse<GenerateResponse>(response);

      setLatestResult(data);
      await Promise.all([refreshHistory(), refreshSuggestions(), refreshStats()]);
      setActiveTab("history");
      setMessage(`Terminé en ${data.elapsed_seconds.toFixed(2)}s (RTF ${(data.rtf ?? 0).toFixed(2)}).`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Erreur de génération.";
      setError(detail);
      setMessage("");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleAddSpeaker(event: FormEvent): Promise<void> {
    event.preventDefault();

    try {
      if (!speakerPromptFile && !speakerPromptMediaId) {
        throw new Error("Ajoutez un fichier prompt ou sélectionnez un média existant.");
      }
      setBusyAction("speaker-add");
      setError("");
      setMessage("Ajout du speaker zero-shot...");

      const payload: Record<string, string> = {
        prompt_text: speakerPromptText,
        zero_shot_spk_id: speakerIdToAdd,
      };
      if (speakerPromptMediaId) {
        payload.prompt_wav_media_id = speakerPromptMediaId;
      }

      const formData = new FormData();
      formData.append("payload", JSON.stringify(payload));
      if (speakerPromptFile) {
        formData.append("prompt_wav", speakerPromptFile);
      }

      const response = await fetch(apiUrl("/api/speakers/zero-shot"), {
        method: "POST",
        body: formData,
      });
      await parseApiResponse<{ ok: boolean }>(response);

      await refreshSpeakers();
      await refreshStats();
      setSpeakerIdToAdd("");
      setSpeakerPromptText("");
      setSpeakerPromptFile(null);
      setSpeakerPromptMediaId("");
      setMessage("Speaker zero-shot ajouté.");
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Erreur ajout speaker.";
      setError(detail);
      setMessage("");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleSaveSpeakers(): Promise<void> {
    try {
      setBusyAction("speaker-save");
      setError("");
      setMessage("Sauvegarde de la banque de speakers...");

      const response = await fetch(apiUrl("/api/speakers/save"), { method: "POST" });
      await parseApiResponse<{ ok: boolean }>(response);
      await refreshStats();
      setMessage("Banque de speakers sauvegardée.");
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Erreur de sauvegarde speakers.";
      setError(detail);
      setMessage("");
    } finally {
      setBusyAction(null);
    }
  }

  async function handleReloadModel(event: FormEvent): Promise<void> {
    event.preventDefault();

    try {
      setBusyAction("model-reload");
      setError("");
      setMessage("Rechargement du modèle...");

      const response = await fetch(apiUrl("/api/model/reload"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model_dir: reloadModelDir }),
      });
      await parseApiResponse<{ ok: boolean }>(response);
      await Promise.all([refreshCapabilities(), refreshSpeakers(), refreshStats(), refreshHealth()]);
      setMessage("Modèle rechargé avec succès.");
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Erreur de reload modèle.";
      setError(detail);
      setMessage("");
    } finally {
      setBusyAction(null);
    }
  }

  async function clearHistory(): Promise<void> {
    try {
      setBusyAction("history-clear");
      setError("");
      const response = await fetch(apiUrl("/api/history"), { method: "DELETE" });
      await parseApiResponse<{ ok: boolean }>(response);
      await Promise.all([refreshHistory(), refreshStats()]);
      setMessage("Historique vidé.");
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Erreur suppression historique.";
      setError(detail);
      setMessage("");
    } finally {
      setBusyAction(null);
    }
  }

  async function createMedia(event: FormEvent): Promise<void> {
    event.preventDefault();

    try {
      if (!mediaUploadFile) {
        throw new Error("Sélectionnez un fichier à importer.");
      }
      setBusyAction("media-create");
      setError("");
      setMessage("Import média en cours...");
      const data = await importMediaFile(mediaUploadFile, {
        kind: mediaUploadKind,
        label: mediaUploadLabel,
        origin: "media_tab:submit",
      });
      await refreshMedia();
      setMediaUploadFile(null);
      setMediaUploadLabel("");
      setMediaUploadKind("generic");
      if (data.deduplicated) {
        setMessage(`Doublon détecté: média existant réutilisé (${data.item.label}).`);
      } else {
        setMessage("Média importé.");
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Erreur import média.";
      setError(detail);
      setMessage("");
    } finally {
      setBusyAction(null);
    }
  }

  async function deleteMedia(mediaId: string): Promise<void> {
    try {
      setBusyAction(`media-delete-${mediaId}`);
      setError("");
      const response = await fetch(apiUrl(`/api/media/${mediaId}`), { method: "DELETE" });
      await parseApiResponse<{ ok: boolean }>(response);
      setMediaItems((previous) => previous.filter((item) => item.id !== mediaId));
      await refreshStats();
      setMessage("Média supprimé.");
    } catch (err) {
      const detail = err instanceof Error ? err.message : "Erreur suppression média.";
      setError(detail);
      setMessage("");
    } finally {
      setBusyAction(null);
    }
  }

  function renderFieldInput(field: FeatureField) {
    const suggestions = selectedSuggestions[field.name] ?? [];

    if (field.type === "textarea") {
      return (
        <>
          <textarea
            id={`field-${field.name}`}
            className="h-28 w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none transition focus-visible:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            value={String(fieldValues[field.name] ?? "")}
            onChange={(event) => updateField(field.name, event.target.value)}
            aria-required={field.required}
          />
          {suggestions.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {suggestions.slice(0, 4).map((item) => (
                <button
                  key={`${field.name}-${item.value}`}
                  type="button"
                  className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-1 text-xs text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                  onClick={() => applySuggestion(field.name, item.value)}
                >
                  {item.value.length > 42 ? `${item.value.slice(0, 39)}...` : item.value}
                </button>
              ))}
            </div>
          ) : null}
        </>
      );
    }

    if (field.type === "boolean") {
      return (
        <div className="flex items-center gap-2 rounded-xl border border-[var(--border)] bg-white px-3 py-2">
          <input
            id={`field-${field.name}`}
            type="checkbox"
            className="h-4 w-4 rounded border-[var(--border)] accent-[var(--accent)]"
            checked={Boolean(fieldValues[field.name])}
            onChange={(event) => updateField(field.name, event.target.checked)}
          />
          <span className="text-xs text-[var(--muted)]">Activer cette option</span>
        </div>
      );
    }

    const datalistId = `suggest-${selectedFeature?.id ?? "feature"}-${field.name}`;

    return (
      <>
        <input
          id={`field-${field.name}`}
          type={field.type === "number" ? "number" : "text"}
          step={field.type === "number" ? "0.05" : undefined}
          className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none transition focus-visible:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
          value={String(fieldValues[field.name] ?? "")}
          list={suggestions.length > 0 ? datalistId : undefined}
          onChange={(event) =>
            updateField(field.name, field.type === "number" ? Number(event.target.value) : event.target.value)
          }
          aria-required={field.required}
        />
        {suggestions.length > 0 ? (
          <datalist id={datalistId}>
            {suggestions.slice(0, 12).map((item) => (
              <option key={`${field.name}-${item.value}`} value={item.value} />
            ))}
          </datalist>
        ) : null}
      </>
    );
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[1280px] flex-col gap-4 px-4 py-5 md:px-8 md:py-8">
      <header className="glass fade-up rounded-3xl p-5 md:p-7">
        <div className="flex flex-col justify-between gap-4 md:flex-row md:items-end">
          <div>
            <p className="text-mono text-xs uppercase tracking-[0.24em] text-[var(--muted)]">CosyVoice Unified Studio</p>
            <h1 className="mt-2 text-2xl font-semibold md:text-4xl">Control Surface Moderne: SSE + Audit + Media Library</h1>
            <p className="mt-2 max-w-3xl text-sm text-[var(--muted)] md:text-base">
              Pilotage temps réel des capacités backend avec historique persistant, suggestions par champ, bibliothèque média et
              conversion directe (mp3/mp4/etc.).
            </p>
          </div>

          <div className="grid grid-cols-2 gap-2 rounded-2xl border border-[var(--border)] bg-[var(--surface-strong)] p-3 text-xs">
            <p className="text-[var(--muted)]">Modèle</p>
            <p className="text-right font-medium">{modelInfo?.model_type ?? "Chargement"}</p>
            <p className="text-[var(--muted)]">Sample Rate</p>
            <p className="text-right text-mono">{modelInfo?.sample_rate ?? "-"} Hz</p>
            <p className="text-[var(--muted)]">Health</p>
            <p className="text-right font-medium">{health?.model_loaded ? "Model loaded" : "Model not loaded"}</p>
            <p className="text-[var(--muted)]">SSE</p>
            <p className="text-right font-medium">
              {sseStatus === "connected" ? "Connecté" : sseStatus === "connecting" ? "Connexion" : "Déconnecté"}
            </p>
            <p className="text-[var(--muted)]">Upload Max</p>
            <p className="text-right font-medium">{maxUploadMb ? `${maxUploadMb} MB` : "n/a"}</p>
          </div>
        </div>
      </header>

      <section className="grid gap-4 lg:grid-cols-[1.8fr_1fr]">
        <div className="glass fade-up rounded-3xl p-5 md:p-6" style={{ animationDelay: "50ms" }}>
          <h2 className="text-lg font-semibold">Endpoint API</h2>
          <div className="mt-3 flex flex-col gap-3 md:flex-row">
            <input
              className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none transition focus-visible:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              value={apiBase}
              onChange={(event) => setApiBase(event.target.value)}
              placeholder={DEFAULT_API_BASE}
              aria-label="URL de l API backend"
            />
            <button
              type="button"
              className="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-medium text-white transition hover:opacity-90 disabled:opacity-60"
              onClick={() => void loadAll()}
              disabled={busy}
            >
              {busyAction === "sync" ? "Sync..." : "Refresh State"}
            </button>
            <button
              type="button"
              className="rounded-xl border border-[var(--border)] bg-white px-4 py-2 text-sm font-medium text-[var(--muted)] transition hover:border-[var(--danger)] hover:text-[var(--danger)]"
              onClick={resetLocalWorkspaceState}
              disabled={busy}
            >
              Reset Local Store
            </button>
          </div>

          <div className="mt-3 flex flex-wrap gap-2 text-xs">
            <span className="rounded-full bg-[var(--accent-soft)] px-3 py-1 text-[var(--accent)]">SSOT actif</span>
            <span className="rounded-full border border-[var(--border)] bg-white px-3 py-1 text-[var(--muted)]">
              Features: {capabilities?.features.length ?? 0}
            </span>
            <span className="rounded-full border border-[var(--border)] bg-white px-3 py-1 text-[var(--muted)]">
              Speakers: {speakerIds.length}
            </span>
            <span className="rounded-full border border-[var(--border)] bg-white px-3 py-1 text-[var(--muted)]">
              Media: {mediaItems.length}
            </span>
            <span className="rounded-full border border-[var(--border)] bg-white px-3 py-1 text-[var(--muted)]">
              History: {historyItems.length}
            </span>
            <span className="rounded-full border border-[var(--border)] bg-white px-3 py-1 text-[var(--muted)]">
              Suggestions: {stats?.counts.suggestion_values ?? 0}
            </span>
            <span className="rounded-full border border-[var(--border)] bg-white px-3 py-1 text-[var(--muted)]">
              Events: {stats?.counts.audit_events ?? auditEvents.length}
            </span>
          </div>
        </div>

        <div className="glass fade-up rounded-3xl p-5 md:p-6" style={{ animationDelay: "90ms" }}>
          <h2 className="text-lg font-semibold">Model Reload</h2>
          <form className="mt-3 space-y-3" onSubmit={(event) => void handleReloadModel(event)}>
            <input
              className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none transition focus-visible:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              value={reloadModelDir}
              onChange={(event) => setReloadModelDir(event.target.value)}
              placeholder="/absolute/path/to/model"
            />
            <button
              type="submit"
              className="w-full rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[#031622] transition hover:opacity-90 disabled:opacity-60"
              disabled={busy || !reloadModelDir.trim()}
            >
              {busyAction === "model-reload" ? "Reload..." : "Reload Active Model"}
            </button>
          </form>
          <p className="mt-3 text-xs text-[var(--muted)] break-all">Current: {modelInfo?.model_dir ?? "n/a"}</p>
        </div>
      </section>

      <div aria-live="polite" role="status" className="space-y-2">
        {error ? (
          <p className="fade-up rounded-2xl border border-[var(--danger)] bg-[var(--surface-strong)] px-4 py-3 text-sm text-[var(--danger)]">
            {error}
          </p>
        ) : null}
        {message ? (
          <p className="fade-up rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm text-[var(--muted)]">{message}</p>
        ) : null}
      </div>

      <nav className="glass fade-up flex flex-wrap gap-2 rounded-3xl p-3" style={{ animationDelay: "120ms" }} aria-label="Sections principales">
        {([
          ["studio", "Generation Studio"],
          ["media", "Media Library"],
          ["history", "Historique"],
          ["audit", "Audit & Live Events"],
        ] as Array<[TabId, string]>).map(([tab, label]) => (
          <button
            key={tab}
            type="button"
            onClick={() => setActiveTab(tab)}
            className={`rounded-xl px-3 py-2 text-sm transition ${activeTab === tab
              ? "bg-[var(--accent)] text-white"
              : "border border-[var(--border)] bg-white text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
              }`}
            aria-pressed={activeTab === tab}
          >
            {label}
          </button>
        ))}
      </nav>

      <section className="glass fade-up rounded-3xl p-4 md:p-5" style={{ animationDelay: "140ms" }}>
        <div className="grid gap-2 md:grid-cols-4">
          <article className="rounded-2xl border border-[var(--border)] bg-white p-3">
            <p className="text-xs text-[var(--muted)]">Features actives</p>
            <p className="mt-1 text-xl font-semibold">{stats?.counts.features ?? capabilities?.features.length ?? 0}</p>
          </article>
          <article className="rounded-2xl border border-[var(--border)] bg-white p-3">
            <p className="text-xs text-[var(--muted)]">Speakers disponibles</p>
            <p className="mt-1 text-xl font-semibold">{stats?.counts.speakers ?? speakerIds.length}</p>
          </article>
          <article className="rounded-2xl border border-[var(--border)] bg-white p-3">
            <p className="text-xs text-[var(--muted)]">Objets média</p>
            <p className="mt-1 text-xl font-semibold">{stats?.counts.media_items ?? mediaItems.length}</p>
          </article>
          <article className="rounded-2xl border border-[var(--border)] bg-white p-3">
            <p className="text-xs text-[var(--muted)]">Historique générations</p>
            <p className="mt-1 text-xl font-semibold">{stats?.counts.history_items ?? historyItems.length}</p>
          </article>
        </div>
        {stats?.latest_generation ? (
          <p className="mt-3 text-xs text-[var(--muted)]">
            Dernière génération: <span className="text-mono">{stats.latest_generation.id}</span> ({stats.latest_generation.feature_id}) à{" "}
            {prettyDate(stats.latest_generation.created_at)}
          </p>
        ) : null}
      </section>

      {activeTab === "studio" ? (
        <section className="grid gap-4 xl:grid-cols-[1.75fr_1fr]">
          <div className="glass fade-up rounded-3xl p-5 md:p-6" style={{ animationDelay: "160ms" }}>
            <h2 className="text-lg font-semibold">Generation Studio</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {capabilities?.features.map((feature) => (
                <button
                  key={feature.id}
                  type="button"
                  onClick={() => setSelectedFeatureId(feature.id)}
                  className={`rounded-full px-3 py-1.5 text-sm transition ${selectedFeatureId === feature.id
                    ? "bg-[var(--accent)] text-white"
                    : "border border-[var(--border)] bg-white text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                    }`}
                >
                  {feature.title}
                </button>
              ))}
            </div>

            {selectedFeature ? (
              <form className="mt-4 space-y-4" onSubmit={(event) => void runGeneration(event)}>
                <p className="rounded-2xl border border-[var(--border)] bg-white px-4 py-3 text-sm text-[var(--muted)]">
                  {selectedFeature.description}
                </p>

                <div className="grid gap-3 md:grid-cols-2">
                  {selectedFeature.text_fields.map((field) => (
                    <div key={field.name} className={`space-y-1.5 ${field.type === "textarea" ? "md:col-span-2" : ""}`}>
                      <label htmlFor={`field-${field.name}`} className="block text-sm font-medium">
                        {field.label}
                        {field.required ? <span className="ml-1 text-[var(--danger)]">*</span> : null}
                      </label>
                      <p className="text-xs text-[var(--muted)]">{fieldHint(field)}</p>
                      {renderFieldInput(field)}
                    </div>
                  ))}
                </div>

                {selectedFeature.audio_fields.length > 0 ? (
                  <div>
                    <h3 className="text-sm font-semibold">Audio Inputs</h3>
                    <p className="mt-1 text-xs text-[var(--muted)]">
                      Chargez un fichier local ou sélectionnez un média existant. Le fichier local est prioritaire s il est présent.
                    </p>
                    <div className="mt-2 grid gap-3 md:grid-cols-2">
                      {selectedFeature.audio_fields.map((field) => (
                        <div key={field.name} className="space-y-1.5 rounded-2xl border border-[var(--border)] bg-white p-3">
                          <p className="text-sm font-medium">
                            {field.label}
                            {field.required ? <span className="ml-1 text-[var(--danger)]">*</span> : null}
                          </p>
                          <input
                            type="file"
                            accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg"
                            className="block w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs"
                            onChange={(event) => {
                              void handleStudioAudioAutoImport(field.name, event.target.files?.[0] ?? null);
                              event.currentTarget.value = "";
                            }}
                          />
                          <select
                            className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs"
                            value={audioMediaRefs[field.name] ?? ""}
                            onChange={(event) => updateAudioMedia(field.name, event.target.value)}
                          >
                            <option value="">{`Aucun média sélectionné (${mediaItems.length} disponible${mediaItems.length > 1 ? "s" : ""})`}</option>
                            {mediaItems.map((item) => (
                              <option key={`${field.name}-${item.id}`} value={item.id}>
                                [{item.kind}] {item.label}
                              </option>
                            ))}
                          </select>
                          <p className="text-mono text-xs text-[var(--muted)]">
                            {autoImportingFields[`studio:${field.name}`]
                              ? "Import auto en cours..."
                              : audioFiles[field.name]
                                ? `Upload local (fallback): ${audioFiles[field.name]?.name}`
                                : audioMediaRefs[field.name]
                                  ? `Media: ${audioMediaRefs[field.name]}`
                                  : "Aucune source"}
                          </p>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {selectedFeature.options.length > 0 ? (
                  <div>
                    <h3 className="text-sm font-semibold">Advanced Options</h3>
                    <div className="mt-2 grid gap-3 md:grid-cols-3">
                      {selectedFeature.options.map((field) => (
                        <div key={field.name} className="space-y-1.5">
                          <label htmlFor={`field-${field.name}`} className="block text-sm font-medium">
                            {field.label}
                          </label>
                          <p className="text-xs text-[var(--muted)]">{fieldHint(field)}</p>
                          {renderFieldInput(field)}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                <button
                  type="submit"
                  className="w-full rounded-xl bg-[var(--accent)] px-4 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
                  disabled={busy || Object.values(autoImportingFields).some(Boolean)}
                >
                  {busyAction === "generate" ? "Processing..." : `Run ${selectedFeature.title}`}
                </button>
              </form>
            ) : (
              <p className="mt-4 text-sm text-[var(--muted)]">Aucune feature compatible avec le modèle actif.</p>
            )}
          </div>

          <div className="glass fade-up rounded-3xl p-5 md:p-6" style={{ animationDelay: "200ms" }}>
            <h2 className="text-lg font-semibold">Latest Output</h2>
            {latestResult ? (
              <div className="mt-3 space-y-3">
                <div className="grid grid-cols-2 gap-2 text-xs text-[var(--muted)]">
                  <p>Feature: {latestResult.feature_id}</p>
                  <p>Rate: {latestResult.sample_rate} Hz</p>
                  <p>Duration: {prettyDuration(latestResult.duration_seconds)}</p>
                  <p>RTF: {(latestResult.rtf ?? 0).toFixed(2)}</p>
                </div>
                <audio controls src={apiUrl(latestResult.audio_url)} className="w-full rounded-xl border border-[var(--border)] bg-white" />
                <div className="flex flex-wrap gap-2">
                  {conversionFormats.map((format) => (
                    <a
                      key={`latest-${format}`}
                      className="rounded-full border border-[var(--border)] bg-white px-3 py-1 text-xs text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                      href={apiUrl(`/api/history/${latestResult.id}/convert?format=${encodeURIComponent(format)}`)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {format.toUpperCase()}
                    </a>
                  ))}
                </div>
                <p className="text-mono break-all text-xs text-[var(--muted)]">{latestResult.id}</p>
              </div>
            ) : (
              <p className="mt-3 text-sm text-[var(--muted)]">Aucun output pour le moment.</p>
            )}

            <div className="mt-6 border-t border-[var(--border)] pt-4">
              <h3 className="text-sm font-semibold">Speakers</h3>
              <div className="mt-2 flex gap-2">
                <button
                  type="button"
                  className="rounded-xl border border-[var(--border)] bg-white px-3 py-1.5 text-xs text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                  onClick={() => void refreshSpeakers()}
                  disabled={busy}
                >
                  Refresh
                </button>
                <button
                  type="button"
                  className="rounded-xl border border-[var(--border)] bg-white px-3 py-1.5 text-xs text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                  onClick={() => void handleSaveSpeakers()}
                  disabled={busy}
                >
                  {busyAction === "speaker-save" ? "Saving..." : "Save Bank"}
                </button>
              </div>
              <div className="mt-2 max-h-28 overflow-auto rounded-xl border border-[var(--border)] bg-white p-2 text-xs text-[var(--muted)]">
                {speakerIds.length === 0 ? "No speakers listed." : speakerIds.join(", ")}
              </div>
              <form className="mt-3 space-y-2" onSubmit={(event) => void handleAddSpeaker(event)}>
                <input
                  className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs outline-none transition focus-visible:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  placeholder="zero-shot speaker id"
                  value={speakerIdToAdd}
                  onChange={(event) => setSpeakerIdToAdd(event.target.value)}
                />
                <textarea
                  className="h-20 w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs outline-none transition focus-visible:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                  placeholder="prompt transcript"
                  value={speakerPromptText}
                  onChange={(event) => setSpeakerPromptText(event.target.value)}
                />
                <input
                  type="file"
                  accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg"
                  className="block w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs"
                  onChange={(event) => {
                    void handleSpeakerAudioAutoImport(event.target.files?.[0] ?? null);
                    event.currentTarget.value = "";
                  }}
                />
                {autoImportingSpeaker ? <p className="text-xs text-[var(--muted)]">Import auto speaker en cours...</p> : null}
                <select
                  className="w-full rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-xs"
                  value={speakerPromptMediaId}
                  onChange={(event) => setSpeakerPromptMediaId(event.target.value)}
                >
                  <option value="">{`Aucun média prompt (${mediaItems.length} disponible${mediaItems.length > 1 ? "s" : ""})`}</option>
                  {mediaItems.map((item) => (
                    <option key={`speaker-media-${item.id}`} value={item.id}>
                      [{item.kind}] {item.label}
                    </option>
                  ))}
                </select>
                <button
                  type="submit"
                  className="w-full rounded-xl bg-[var(--accent)] px-3 py-2 text-xs font-semibold text-[#031622] transition hover:opacity-90 disabled:opacity-60"
                  disabled={
                    busy ||
                    autoImportingSpeaker ||
                    !speakerIdToAdd.trim() ||
                    !speakerPromptText.trim() ||
                    (!speakerPromptFile && !speakerPromptMediaId)
                  }
                >
                  {busyAction === "speaker-add" ? "Adding..." : "Add Zero-Shot Speaker"}
                </button>
              </form>
            </div>
          </div>
        </section>
      ) : null}

      {activeTab === "media" ? (
        <section className="glass fade-up rounded-3xl p-5 md:p-6" style={{ animationDelay: "180ms" }}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Media Library</h2>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded-xl border border-[var(--border)] bg-white px-3 py-1.5 text-xs text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                onClick={() => void refreshMedia()}
                disabled={busy}
              >
                Refresh Media
              </button>
              <button
                type="button"
                className="rounded-xl border border-[var(--border)] bg-white px-3 py-1.5 text-xs text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                onClick={exportMediaAsJson}
                disabled={filteredMediaItems.length === 0}
              >
                Export JSON
              </button>
            </div>
          </div>

          <form className="mt-3 grid gap-3 md:grid-cols-[1.2fr_0.8fr_1fr_auto]" onSubmit={(event) => void createMedia(event)}>
            <input
              className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none transition focus-visible:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              placeholder="Label media (optionnel)"
              value={mediaUploadLabel}
              onChange={(event) => setMediaUploadLabel(event.target.value)}
            />
            <select
              className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm"
              value={mediaUploadKind}
              onChange={(event) => setMediaUploadKind(event.target.value as MediaKind)}
            >
              <option value="generic">generic</option>
              <option value="prompt">prompt</option>
              <option value="source">source</option>
            </select>
            <input
              type="file"
              accept="audio/*,.wav,.mp3,.m4a,.flac,.ogg"
              className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm"
              onChange={(event) => {
                void handleMediaTabAutoImport(event.target.files?.[0] ?? null);
                event.currentTarget.value = "";
              }}
            />
            <button
              type="submit"
              className="rounded-xl bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
              disabled={busy || autoImportingMedia || !mediaUploadFile}
            >
              {autoImportingMedia ? "Import auto..." : busyAction === "media-create" ? "Upload..." : "Ajouter"}
            </button>
          </form>
          {autoImportingMedia ? (
            <p className="mt-2 text-xs text-[var(--muted)]">Import automatique en cours après sélection du fichier...</p>
          ) : null}

          <div className="mt-3 grid gap-3 md:grid-cols-[1fr_220px]">
            <input
              className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none transition focus-visible:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              placeholder="Rechercher id, label ou nom de fichier..."
              value={mediaQuery}
              onChange={(event) => setMediaQuery(event.target.value)}
            />
            <select
              className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm"
              value={mediaKindFilter}
              onChange={(event) => setMediaKindFilter(event.target.value as "all" | MediaKind)}
            >
              <option value="all">Tous les types</option>
              <option value="generic">generic</option>
              <option value="prompt">prompt</option>
              <option value="source">source</option>
            </select>
          </div>

          {filteredMediaItems.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--muted)]">Aucun média enregistré.</p>
          ) : (
            <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              {filteredMediaItems.map((item) => (
                <article key={item.id} className="rounded-2xl border border-[var(--border)] bg-white p-3">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <span className="rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[var(--accent)]">{item.kind}</span>
                    <span className="text-[var(--muted)]">{prettyBytes(item.size_bytes)}</span>
                  </div>
                  <p className="mt-2 text-sm font-medium">{item.label}</p>
                  <p className="text-mono mt-1 truncate text-xs text-[var(--muted)]">{item.original_name}</p>
                  <p className="mt-1 text-xs text-[var(--muted)]">{prettyDate(item.created_at)}</p>
                  <audio controls src={apiUrl(item.file_url)} className="mt-2 w-full rounded-xl border border-[var(--border)]" />
                  <div className="mt-2 flex flex-wrap gap-1">
                    {conversionFormats.map((format) => (
                      <a
                        key={`media-${item.id}-${format}`}
                        className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-[10px] text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                        href={apiUrl(`/api/media/${item.id}/convert?format=${encodeURIComponent(format)}`)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {format}
                      </a>
                    ))}
                  </div>
                  <button
                    type="button"
                    className="mt-2 w-full rounded-xl border border-[var(--border)] bg-white px-2 py-1 text-xs text-[var(--muted)] transition hover:border-[var(--danger)] hover:text-[var(--danger)]"
                    onClick={() => void deleteMedia(item.id)}
                    disabled={busy}
                  >
                    Supprimer
                  </button>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {activeTab === "history" ? (
        <section className="glass fade-up rounded-3xl p-5 md:p-6" style={{ animationDelay: "180ms" }}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-lg font-semibold">Audio History (Inputs + Conversion)</h2>
            <div className="flex gap-2">
              <button
                type="button"
                className="rounded-xl border border-[var(--border)] bg-white px-3 py-1.5 text-xs text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                onClick={() => void refreshHistory()}
                disabled={busy}
              >
                Refresh
              </button>
              <button
                type="button"
                className="rounded-xl border border-[var(--border)] bg-white px-3 py-1.5 text-xs text-[var(--muted)] hover:border-[var(--danger)] hover:text-[var(--danger)]"
                onClick={() => void clearHistory()}
                disabled={busy || historyItems.length === 0}
              >
                {busyAction === "history-clear" ? "Clearing..." : "Clear History"}
              </button>
              <button
                type="button"
                className="rounded-xl border border-[var(--border)] bg-white px-3 py-1.5 text-xs text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                onClick={exportHistoryAsJson}
                disabled={filteredHistoryItems.length === 0}
              >
                Export JSON
              </button>
            </div>
          </div>

          <div className="mt-3 grid gap-3 md:grid-cols-[1fr_220px]">
            <input
              className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none transition focus-visible:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              placeholder="Rechercher id, feature ou inputs..."
              value={historyQuery}
              onChange={(event) => setHistoryQuery(event.target.value)}
            />
            <select
              className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm"
              value={historyFeatureFilter}
              onChange={(event) => setHistoryFeatureFilter(event.target.value)}
            >
              <option value="all">Toutes les features</option>
              {capabilities?.features.map((feature) => (
                <option key={`filter-feature-${feature.id}`} value={feature.id}>
                  {feature.title}
                </option>
              ))}
            </select>
          </div>

          {filteredHistoryItems.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--muted)]">Aucun item généré.</p>
          ) : (
            <div className="mt-3 grid gap-3 md:grid-cols-2">
              {filteredHistoryItems.map((item) => (
                <article key={item.id} className="rounded-2xl border border-[var(--border)] bg-white p-3">
                  <div className="flex items-center justify-between text-xs text-[var(--muted)]">
                    <span className="text-mono">{item.feature_id}</span>
                    <span>{prettyDuration(item.duration_seconds)}</span>
                  </div>
                  <p className="mt-1 text-mono truncate text-xs text-[var(--muted)]">{item.id}</p>
                  <p className="mt-1 text-xs text-[var(--muted)]">{prettyDate(item.created_at)}</p>
                  <audio controls src={apiUrl(item.audio_url)} className="mt-2 w-full rounded-xl border border-[var(--border)]" />
                  <div className="mt-2 flex flex-wrap gap-1">
                    {conversionFormats.map((format) => (
                      <a
                        key={`history-${item.id}-${format}`}
                        className="rounded-full border border-[var(--border)] bg-[var(--surface)] px-2 py-0.5 text-[10px] text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
                        href={apiUrl(`/api/history/${item.id}/convert?format=${encodeURIComponent(format)}`)}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {format}
                      </a>
                    ))}
                  </div>

                  <details className="mt-2 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-2">
                    <summary className="cursor-pointer text-xs font-medium text-[var(--muted)]">Inputs détaillés</summary>
                    <div className="mt-2 space-y-1 text-xs">
                      {Object.entries(item.inputs ?? item.inputs_preview).map(([key, value]) => (
                        <p key={`${item.id}-${key}`}>
                          <span className="text-mono text-[var(--muted)]">{key}</span>: {stringPreview(value)}
                        </p>
                      ))}
                    </div>
                  </details>
                </article>
              ))}
            </div>
          )}
        </section>
      ) : null}

      {activeTab === "audit" ? (
        <section className="grid gap-4 lg:grid-cols-[1fr_1.5fr]">
          <div className="glass fade-up rounded-3xl p-5 md:p-6" style={{ animationDelay: "180ms" }}>
            <h2 className="text-lg font-semibold">Live Stream</h2>
            <p className="mt-2 text-sm text-[var(--muted)]">
              Flux SSE backend:
              <span className="ml-2 rounded-full border border-[var(--border)] bg-white px-2 py-0.5 text-xs">
                {sseStatus === "connected" ? "connecté" : sseStatus === "connecting" ? "connexion" : "déconnecté"}
              </span>
            </p>
            <p className="mt-3 text-xs text-[var(--muted)]">
              L audit capture: reload modèle, génération start/success/failure, opérations speakers, CRUD media, clear history.
            </p>
            <button
              type="button"
              className="mt-3 rounded-xl border border-[var(--border)] bg-white px-3 py-1.5 text-xs text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
              onClick={() => void refreshAuditEvents()}
            >
              Recharger les événements
            </button>
            <button
              type="button"
              className="mt-2 rounded-xl border border-[var(--border)] bg-white px-3 py-1.5 text-xs text-[var(--muted)] hover:border-[var(--accent)] hover:text-[var(--accent)]"
              onClick={exportAuditAsJson}
              disabled={filteredAuditEvents.length === 0}
            >
              Export JSON
            </button>
          </div>

          <div className="glass fade-up rounded-3xl p-5 md:p-6" style={{ animationDelay: "220ms" }}>
            <h2 className="text-lg font-semibold">Audit Timeline</h2>
            <div className="mt-3 grid gap-3 md:grid-cols-[1fr_220px]">
              <input
                className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm outline-none transition focus-visible:border-[var(--accent)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
                placeholder="Rechercher id, type ou payload..."
                value={auditQuery}
                onChange={(event) => setAuditQuery(event.target.value)}
              />
              <select
                className="rounded-xl border border-[var(--border)] bg-white px-3 py-2 text-sm"
                value={auditTypeFilter}
                onChange={(event) => setAuditTypeFilter(event.target.value)}
              >
                <option value="all">Tous les types</option>
                {auditEventTypes.map((type) => (
                  <option key={`audit-type-${type}`} value={type}>
                    {type}
                  </option>
                ))}
              </select>
            </div>
            {filteredAuditEvents.length === 0 ? (
              <p className="mt-3 text-sm text-[var(--muted)]">Aucun événement.</p>
            ) : (
              <div className="mt-3 max-h-[560px] space-y-2 overflow-auto pr-1">
                {filteredAuditEvents.map((event) => (
                  <article key={event.id} className="rounded-2xl border border-[var(--border)] bg-white p-3">
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="text-mono rounded-full bg-[var(--accent-soft)] px-2 py-0.5 text-[var(--accent)]">{event.type}</span>
                      <span className="text-[var(--muted)]">{prettyDate(event.created_at)}</span>
                    </div>
                    <pre className="mt-2 max-h-48 overflow-auto rounded-xl bg-[var(--surface)] p-2 text-[11px] text-[var(--muted)]">
                      {JSON.stringify(event.payload, null, 2)}
                    </pre>
                  </article>
                ))}
              </div>
            )}
          </div>
        </section>
      ) : null}
    </main>
  );
}
