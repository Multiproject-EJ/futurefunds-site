-- sql/006_ai_registry.sql
-- Adds shared AI credential metadata and model registry for the automation pipeline.

-- ===== Extend credential storage =====
create table if not exists public.editor_api_credentials (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  label text,
  api_key text not null,
  is_active boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.editor_api_credentials
  add column if not exists scopes text[] default array['editor'];

alter table public.editor_api_credentials
  alter column scopes set default array['editor'];

alter table public.editor_api_credentials
  add column if not exists tier text default 'standard';

alter table public.editor_api_credentials
  add column if not exists metadata jsonb default '{}'::jsonb;

update public.editor_api_credentials
  set scopes = array['editor']
  where scopes is null;

-- ensure updated_at has a default
alter table public.editor_api_credentials
  alter column updated_at set default now();

-- ===== Model registry =====
create table if not exists public.ai_model_profiles (
  id bigserial primary key,
  slug text not null unique,
  label text not null,
  provider text not null,
  model_name text not null,
  base_url text,
  tier text default 'standard',
  price_in numeric(12,4) default 0,
  price_out numeric(12,4) default 0,
  is_active boolean default true,
  notes text,
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.ai_model_profiles
  alter column updated_at set default now();

-- Seed or refresh commonly used models
insert into public.ai_model_profiles (slug, label, provider, model_name, base_url, tier, price_in, price_out, notes)
values
  ('openrouter/dolphin-mistral-free', 'Dolphin 3.0 Mistral · free', 'openrouter', 'cognitivecomputations/dolphin3.0-mistral-24b:free', 'https://openrouter.ai/api/v1', 'free', 0, 0, 'Fast formatter / QA (free tier).'),
  ('openrouter/deepseek-r1-free', 'DeepSeek R1 Distill 70B · free', 'openrouter', 'deepseek/deepseek-r1-distill-llama-70b:free', 'https://openrouter.ai/api/v1', 'free', 0, 0, 'Reasoning model (free tier).'),
  ('openrouter/llama-3.3-70b-free', 'Llama 3.3 70B Instruct · free', 'openrouter', 'meta-llama/llama-3.3-70b-instruct:free', 'https://openrouter.ai/api/v1', 'free', 0, 0, 'General purpose summariser.'),
  ('openrouter/gemini-2-flash-free', 'Gemini 2.0 Flash Exp · free', 'openrouter', 'google/gemini-2.0-flash-exp:free', 'https://openrouter.ai/api/v1', 'free', 0, 0, 'Structured reasoning, zero cost.'),
  ('openrouter/mistral-small-free', 'Mistral Small 3 · free', 'openrouter', 'mistralai/mistral-small-24b-instruct-2501:free', 'https://openrouter.ai/api/v1', 'free', 0, 0, 'Lightweight reformatter.'),
  ('openrouter/gpt-4o-mini', 'GPT-4o mini (OpenRouter)', 'openrouter', 'openai/gpt-4o-mini', 'https://openrouter.ai/api/v1', 'standard', 0.1500, 0.6000, 'Balanced quality vs price.'),
  ('openrouter/gpt-4o', 'GPT-4o (OpenRouter)', 'openrouter', 'openai/gpt-4o', 'https://openrouter.ai/api/v1', 'premium', 2.5000, 10.0000, 'High quality general model.'),
  ('openrouter/gpt-5-mini', 'GPT-5 mini (OpenRouter)', 'openrouter', 'openai/gpt-5-mini', 'https://openrouter.ai/api/v1', 'premium', 0.2500, 2.0000, 'Advanced mid-tier reasoning.'),
  ('openrouter/gpt-5-preview', 'GPT-5 preview (OpenRouter)', 'openrouter', 'openai/gpt-5-preview', 'https://openrouter.ai/api/v1', 'premium', 1.2500, 10.0000, 'Flagship deep-dive model.'),
  ('openai/gpt-4o-mini', 'GPT-4o mini (OpenAI)', 'openai', 'gpt-4o-mini', 'https://api.openai.com/v1', 'standard', 0.1500, 0.6000, 'Direct OpenAI endpoint.'),
  ('openai/gpt-4o', 'GPT-4o (OpenAI)', 'openai', 'gpt-4o', 'https://api.openai.com/v1', 'premium', 2.5000, 10.0000, 'Direct OpenAI endpoint.'),
  ('openai/gpt-5-mini', 'GPT-5 mini (OpenAI)', 'openai', 'gpt-5-mini', 'https://api.openai.com/v1', 'premium', 0.2500, 2.0000, 'Direct OpenAI endpoint.'),
  ('openai/gpt-5-preview', 'GPT-5 preview (OpenAI)', 'openai', 'gpt-5-preview', 'https://api.openai.com/v1', 'premium', 1.2500, 10.0000, 'Direct OpenAI endpoint. For highest quality deep dives.')
on conflict (slug) do update
set label = excluded.label,
    provider = excluded.provider,
    model_name = excluded.model_name,
    base_url = excluded.base_url,
    tier = excluded.tier,
    price_in = excluded.price_in,
    price_out = excluded.price_out,
    is_active = true,
    notes = excluded.notes,
    updated_at = now();
