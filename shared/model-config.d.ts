export interface ModelProfile {
  label?: string;
  provider: string;
  model_name: string;
  price_in?: number;
  price_out?: number;
  metadata?: Record<string, unknown> | null;
  slug?: string;
}

export interface StageRequestSettings {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_output_tokens?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  stop_sequences?: string[];
  metadata?: Record<string, unknown> | null;
  cache?: Record<string, unknown> | null;
}

export interface StageRetrySettings {
  attempts?: number;
  backoff_ms?: number;
  jitter?: number;
}

export interface StageDefaults {
  default_model?: string;
  fallback_model?: string;
  embedding_model?: string;
  request?: StageRequestSettings;
  retry?: StageRetrySettings;
}

export function getModelProfile(slug: string): ModelProfile | null;
export function getAllModels(): Record<string, ModelProfile>;
export function getStageDefaults(stage: string): StageDefaults | null;
export function getAllStageDefaults(): Record<string, StageDefaults>;
