export type FieldType = "text" | "textarea" | "number" | "boolean";

export type FeatureField = {
  name: string;
  label: string;
  type: FieldType;
  required: boolean;
  default?: string | number | boolean;
};

export type AudioField = {
  name: string;
  label: string;
  required: boolean;
};

export type FeatureSpec = {
  id: string;
  title: string;
  description: string;
  method: string;
  supported_model_types: string[];
  text_fields: FeatureField[];
  audio_fields: AudioField[];
  options: FeatureField[];
};

export type ModelInfo = {
  model_type: string;
  model_dir: string;
  sample_rate: number;
  loaded_at: string;
};

export type SpeakerOperation = {
  id: string;
  title: string;
  description: string;
};

export type PlatformInfo = {
  events_sse?: boolean;
  history_persistence?: boolean;
  media_library?: boolean;
  field_suggestions?: boolean;
  supported_conversions?: string[];
  max_upload_bytes?: number;
  stats_endpoint?: string;
};

export type CapabilitiesResponse = {
  model: ModelInfo;
  features: FeatureSpec[];
  speaker_operations: SpeakerOperation[];
  platform?: PlatformInfo;
};

export type HistoryItem = {
  id: string;
  feature_id: string;
  created_at: string;
  duration_seconds: number;
  sample_rate: number;
  audio_url: string;
  inputs_preview: Record<string, unknown>;
  inputs?: Record<string, unknown>;
};

export type HistoryResponse = {
  count: number;
  items: HistoryItem[];
};

export type SpeakerListResponse = {
  count: number;
  speakers: string[];
};

export type GenerateResponse = {
  ok: boolean;
  id: string;
  feature_id: string;
  model_type: string;
  sample_rate: number;
  duration_seconds: number;
  elapsed_seconds: number;
  rtf: number | null;
  chunk_count: number;
  audio_url: string;
};

export type HealthResponse = {
  status: string;
  model_loaded: boolean;
  model_type: string | null;
  model_dir: string | null;
  loaded_at: string | null;
};

export type StatsResponse = {
  model: {
    model_type: string;
    model_dir: string;
    sample_rate: number;
    loaded_at: string;
  };
  counts: {
    features: number;
    speakers: number;
    history_items: number;
    media_items: number;
    audit_events: number;
    suggestion_values: number;
  };
  history_by_feature: Record<string, number>;
  latest_generation: {
    id: string;
    feature_id: string;
    created_at: string;
    duration_seconds: number;
  } | null;
};

export type MediaKind = "prompt" | "source" | "generic";

export type MediaItem = {
  id: string;
  label: string;
  kind: MediaKind;
  created_at: string;
  size_bytes: number;
  original_name: string;
  mime_type: string;
  file_url: string;
};

export type MediaResponse = {
  count: number;
  items: MediaItem[];
};

export type MediaCreateResponse = {
  ok: boolean;
  item: MediaItem;
  created: boolean;
  deduplicated: boolean;
};

export type SuggestionEntry = {
  value: string;
  count: number;
  last_used: string;
};

export type SuggestionsResponse = {
  features: Record<string, Record<string, SuggestionEntry[]>>;
};

export type AuditEvent = {
  id: string;
  type: string;
  created_at: string;
  payload: Record<string, unknown>;
};

export type AuditEventsResponse = {
  count: number;
  items: AuditEvent[];
};

export type ApiErrorPayload = {
  detail?: string;
};

export async function parseApiResponse<T>(response: Response): Promise<T> {
  const data = (await response.json()) as T | ApiErrorPayload;
  if (!response.ok) {
    const detail =
      typeof (data as ApiErrorPayload).detail === "string"
        ? (data as ApiErrorPayload).detail
        : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return data as T;
}

export function buildApiUrl(apiBase: string, path: string): string {
  return `${apiBase.replace(/\/$/, "")}${path}`;
}
