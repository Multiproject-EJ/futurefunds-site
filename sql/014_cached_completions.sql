-- sql/014_cached_completions.sql
-- Cache table for deterministic LLM responses that can be reused across runs.

set check_function_bodies = off;

create table if not exists public.cached_completions (
  id uuid primary key default gen_random_uuid(),
  model_slug text not null,
  cache_key text not null,
  prompt_hash text not null,
  request_body jsonb not null,
  response_body jsonb not null,
  usage jsonb,
  context jsonb,
  tags text[] default array[]::text[],
  hit_count integer not null default 0,
  last_hit_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists cached_completions_model_cache_key_idx
  on public.cached_completions (model_slug, cache_key);

create index if not exists cached_completions_expires_at_idx
  on public.cached_completions (expires_at)
  where expires_at is not null;

