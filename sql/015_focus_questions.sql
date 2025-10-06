create table if not exists public.focus_question_templates (
  id bigserial primary key,
  slug text not null unique,
  label text not null,
  question text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.focus_question_requests (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.runs(id) on delete cascade,
  ticker text not null references public.tickers(ticker) on delete cascade,
  template_id bigint references public.focus_question_templates(id) on delete set null,
  question text not null,
  status text not null default 'pending' check (status in ('pending','queued','in_progress','answered','failed','cancelled')),
  answer jsonb,
  answer_text text,
  tokens_in int,
  tokens_out int,
  cost_usd numeric(12,4),
  cache_hit boolean default false,
  metadata jsonb,
  created_by uuid references auth.users(id),
  created_by_email text,
  answered_by uuid references auth.users(id),
  answered_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  answered_at timestamptz
);

create index if not exists focus_requests_run_idx on public.focus_question_requests (run_id, status, created_at);
create index if not exists focus_requests_ticker_idx on public.focus_question_requests (ticker, status);
create index if not exists focus_requests_created_idx on public.focus_question_requests (created_at desc);

create or replace function public.touch_focus_request()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace trigger focus_requests_updated_at
before update on public.focus_question_requests
for each row
execute function public.touch_focus_request();

create or replace function public.run_focus_summary(p_run_id uuid)
returns table (
  total_requests bigint,
  pending bigint,
  completed bigint,
  failed bigint
)
language sql
stable
as $$
  select
    count(*)::bigint as total_requests,
    count(*) filter (where status in ('pending','queued','in_progress'))::bigint as pending,
    count(*) filter (where status = 'answered')::bigint as completed,
    count(*) filter (where status = 'failed')::bigint as failed
  from public.focus_question_requests
  where run_id = p_run_id;
$$;

insert into public.focus_question_templates (slug, label, question)
values
  ('capital-allocation', 'Capital allocation discipline', 'Assess how effectively management has allocated capital over the last three years and whether their stated priorities align with shareholder value creation.'),
  ('growth-durability', 'Growth durability check', 'Evaluate the durability of the company''s revenue growth and identify the leading indicators that could cause a break in the trend.'),
  ('risk-checklist', 'Key risk checklist', 'Outline the top three fundamental risks that could invalidate the bullish thesis and how we''d monitor them.')
on conflict (slug) do nothing;
