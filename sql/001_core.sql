create extension if not exists pgcrypto;

create table if not exists public.tickers (
  ticker text primary key,
  name text,
  exchange text,
  country text,
  sector text,
  industry text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.sector_prompts (
  sector text primary key,
  notes text
);

create table if not exists public.runs (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  status text check (status in ('queued','running','done','failed')) default 'queued',
  notes text,
  stop_requested boolean default false
);

create table if not exists public.run_items (
  run_id uuid references public.runs(id) on delete cascade,
  ticker text references public.tickers(ticker) on delete cascade,
  stage int default 0,
  label text,
  status text check (status in ('pending','ok','skipped','failed')) default 'pending',
  spend_est_usd numeric(12,4) default 0,
  updated_at timestamptz default now(),
  primary key (run_id, ticker)
);

create table if not exists public.answers (
  id bigserial primary key,
  run_id uuid references public.runs(id) on delete cascade,
  ticker text references public.tickers(ticker) on delete cascade,
  stage int,
  question_group text,
  answer_json jsonb,
  answer_text text,
  tokens_in int,
  tokens_out int,
  cost_usd numeric(12,4),
  created_at timestamptz default now()
);

create table if not exists public.cost_ledger (
  id bigserial primary key,
  run_id uuid references public.runs(id),
  stage int,
  model text,
  tokens_in bigint,
  tokens_out bigint,
  cost_usd numeric(12,4),
  created_at timestamptz default now()
);

create table if not exists public.doc_chunks (
  id bigserial primary key,
  ticker text references public.tickers(ticker) on delete cascade,
  source text,
  chunk text
);
