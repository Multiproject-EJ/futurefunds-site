-- Watchlists and ticker maintenance

-- Helper to detect admin role from profiles
create or replace function public.is_admin(uid uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = uid
      and (
        lower(coalesce(p.role, '')) like '%admin%'
        or lower(coalesce(p.role, '')) like '%superadmin%'
        or lower(coalesce(p.role, '')) like '%owner%'
        or lower(coalesce(p.role, '')) like '%staff%'
      )
  );
$$;

-- Extend tickers with lifecycle metadata
alter table public.tickers
  add column if not exists status text default 'active' check (status in ('active','inactive','delisted','pending','unknown')),
  add column if not exists listed_at date,
  add column if not exists delisted_at date,
  add column if not exists aliases text[] default '{}',
  add column if not exists last_seen_at timestamptz default now(),
  add column if not exists source text,
  add column if not exists metadata jsonb default '{}'::jsonb;

alter table public.tickers alter column updated_at set default now();

create table if not exists public.ticker_events (
  id bigserial primary key,
  ticker text references public.tickers(ticker) on delete cascade,
  event_type text not null,
  details jsonb default '{}'::jsonb,
  created_at timestamptz default now()
);

create index if not exists ticker_events_ticker_idx on public.ticker_events(ticker);
create index if not exists ticker_events_type_idx on public.ticker_events(event_type);

-- Watchlist tables
create table if not exists public.watchlists (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  description text,
  is_system boolean default false,
  is_public boolean default false,
  created_by uuid references auth.users(id),
  created_by_email text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create table if not exists public.watchlist_entries (
  watchlist_id uuid references public.watchlists(id) on delete cascade,
  ticker text references public.tickers(ticker) on delete cascade,
  rank int,
  notes text,
  added_at timestamptz default now(),
  removed_at timestamptz,
  primary key (watchlist_id, ticker)
);

alter table public.watchlists enable row level security;
alter table public.watchlist_entries enable row level security;
alter table public.ticker_events enable row level security;

-- Recreate policies explicitly instead of relying on `CREATE POLICY IF NOT EXISTS`,
-- which PostgreSQL does not support. Dropping first keeps the migration idempotent
-- while ensuring policy definitions are refreshed on subsequent runs.
drop policy if exists ticker_events_read on public.ticker_events;
create policy ticker_events_read on public.ticker_events
  for select
  using (true);

-- Basic ticker policies: read for everyone, modify for admins/service role
alter table public.tickers enable row level security;

drop policy if exists tickers_read on public.tickers;
create policy tickers_read on public.tickers
  for select
  using (true);

drop policy if exists tickers_admin_write on public.tickers;
create policy tickers_admin_write on public.tickers
  for insert
  with check (public.is_admin(auth.uid()));

drop policy if exists tickers_admin_update on public.tickers;
create policy tickers_admin_update on public.tickers
  for update
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

drop policy if exists tickers_admin_delete on public.tickers;
create policy tickers_admin_delete on public.tickers
  for delete
  using (public.is_admin(auth.uid()));

-- Watchlist policies
drop policy if exists watchlists_read on public.watchlists;
create policy watchlists_read on public.watchlists
  for select
  using (is_public = true or created_by = auth.uid() or public.is_admin(auth.uid()));

drop policy if exists watchlists_insert on public.watchlists;
create policy watchlists_insert on public.watchlists
  for insert
  with check (auth.uid() = created_by and public.is_admin(auth.uid()));

drop policy if exists watchlists_update on public.watchlists;
create policy watchlists_update on public.watchlists
  for update
  using (public.is_admin(auth.uid()) or created_by = auth.uid())
  with check (public.is_admin(auth.uid()) or created_by = auth.uid());

drop policy if exists watchlists_delete on public.watchlists;
create policy watchlists_delete on public.watchlists
  for delete
  using (public.is_admin(auth.uid()) or created_by = auth.uid());

drop policy if exists watchlist_entries_read on public.watchlist_entries;
create policy watchlist_entries_read on public.watchlist_entries
  for select
  using (
    exists (
      select 1
      from public.watchlists w
      where w.id = watchlist_entries.watchlist_id
        and (w.is_public = true or w.created_by = auth.uid() or public.is_admin(auth.uid()))
    )
);

drop policy if exists watchlist_entries_write on public.watchlist_entries;
create policy watchlist_entries_write on public.watchlist_entries
  for all
  using (
    exists (
      select 1
      from public.watchlists w
      where w.id = watchlist_entries.watchlist_id
        and (public.is_admin(auth.uid()) or w.created_by = auth.uid())
    )
  )
  with check (
    exists (
      select 1
      from public.watchlists w
      where w.id = watchlist_entries.watchlist_id
        and (public.is_admin(auth.uid()) or w.created_by = auth.uid())
    )
  );

-- Triggers to keep updated_at fresh
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger watchlists_updated_at
before update on public.watchlists
for each row
execute function public.touch_updated_at();

create trigger tickers_updated_at_touch
before update on public.tickers
for each row
execute function public.touch_updated_at();

-- Add watchlist reference to runs for auditability
alter table public.runs
  add column if not exists watchlist_id uuid references public.watchlists(id);

create index if not exists runs_watchlist_idx on public.runs(watchlist_id);

-- Helper view summarising watchlists with ticker counts
create or replace view public.watchlist_summaries as
select
  w.id,
  w.name,
  w.slug,
  w.description,
  w.is_system,
  w.is_public,
  w.created_by,
  w.created_by_email,
  w.created_at,
  w.updated_at,
  coalesce(
    (
      select count(*)
      from public.watchlist_entries we
      where we.watchlist_id = w.id
        and we.removed_at is null
    ),
    0
  ) as ticker_count
from public.watchlists w;

-- Seed a starter watchlist with sample tickers
insert into public.watchlists (name, slug, description, is_system, is_public)
values
  ('Global blue chips', 'global-blue-chips', 'Flagship multiregion names used for smoke tests.', true, true)
on conflict (slug) do update set
  name = excluded.name,
  description = excluded.description,
  is_system = excluded.is_system,
  is_public = excluded.is_public;

insert into public.watchlist_entries (watchlist_id, ticker, rank)
select w.id, t.ticker, row_number() over (order by t.ticker)
from public.watchlists w
join public.tickers t on true
where w.slug = 'global-blue-chips'
on conflict (watchlist_id, ticker) do update set
  removed_at = null,
  rank = excluded.rank;

