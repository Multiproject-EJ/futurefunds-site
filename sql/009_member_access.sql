alter table public.runs
  add column if not exists created_by uuid references auth.users(id),
  add column if not exists created_by_email text;

create index if not exists runs_created_by_idx on public.runs(created_by);
create index if not exists runs_created_at_idx on public.runs(created_at);
