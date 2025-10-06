create table if not exists public.run_feedback (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.runs(id) on delete cascade,
  ticker text references public.tickers(ticker) on delete set null,
  question_text text not null,
  status text not null default 'pending' check (status in ('pending','in_progress','resolved','dismissed')),
  response_text text,
  context jsonb,
  created_by uuid references auth.users(id),
  created_by_email text,
  resolved_by uuid references auth.users(id),
  resolved_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  resolved_at timestamptz
);

create index if not exists run_feedback_run_idx on public.run_feedback (run_id, status);
create index if not exists run_feedback_created_idx on public.run_feedback (created_at desc);
create index if not exists run_feedback_actor_idx on public.run_feedback (created_by);

create or replace function public.run_feedback_for_run(p_run_id uuid)
returns table (
  id uuid,
  run_id uuid,
  ticker text,
  question_text text,
  status text,
  response_text text,
  context jsonb,
  created_by uuid,
  created_by_email text,
  created_at timestamptz,
  updated_at timestamptz,
  resolved_by uuid,
  resolved_by_email text,
  resolved_at timestamptz
)
language sql
stable
as $$
  select id,
         run_id,
         ticker,
         question_text,
         status,
         response_text,
         context,
         created_by,
         created_by_email,
         created_at,
         updated_at,
         resolved_by,
         resolved_by_email,
         resolved_at
    from public.run_feedback
   where run_id = p_run_id
   order by created_at desc;
$$;
