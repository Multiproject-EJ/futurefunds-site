alter table if exists public.error_logs
  add column if not exists run_id uuid references public.runs(id) on delete set null,
  add column if not exists ticker text references public.tickers(ticker) on delete set null,
  add column if not exists stage int,
  add column if not exists prompt_id text,
  add column if not exists retry_count int default 0,
  add column if not exists status_code int,
  add column if not exists metadata jsonb default '{}'::jsonb,
  alter column payload type jsonb using coalesce(payload, '{}'::jsonb);

create index if not exists error_logs_created_at_idx on public.error_logs(created_at desc);
create index if not exists error_logs_run_idx on public.error_logs(run_id, ticker);
