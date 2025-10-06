-- Automated notification channels and delivery log

-- Create notifications tables for email/Slack alerts
create table if not exists public.notification_channels (
  id uuid primary key default gen_random_uuid(),
  type text not null check (type in ('email','slack_webhook')),
  label text not null,
  target text not null,
  is_active boolean not null default true,
  min_score numeric(5,2) check (min_score is null or (min_score >= 0 and min_score <= 100)),
  conviction_levels text[] default '{}'::text[],
  watchlist_ids uuid[] default '{}'::uuid[],
  metadata jsonb default '{}'::jsonb,
  created_by uuid references auth.users(id),
  created_by_email text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists notification_channels_active_idx
  on public.notification_channels(is_active)
  where is_active = true;

create index if not exists notification_channels_watchlist_idx
  on public.notification_channels using gin(watchlist_ids);

create table if not exists public.notification_events (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid references public.notification_channels(id) on delete set null,
  run_id uuid references public.runs(id) on delete set null,
  ticker text not null,
  stage int not null default 3,
  conviction text,
  verdict text,
  ensemble_score numeric(5,2),
  payload jsonb default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending','sent','failed')),
  error text,
  dispatched_at timestamptz,
  created_at timestamptz default now()
);

create index if not exists notification_events_run_idx on public.notification_events(run_id);
create index if not exists notification_events_ticker_idx on public.notification_events(ticker);
create index if not exists notification_events_channel_idx on public.notification_events(channel_id);
create index if not exists notification_events_status_idx on public.notification_events(status);

create trigger notification_channels_updated_at
before update on public.notification_channels
for each row
execute function public.touch_updated_at();

alter table public.notification_channels enable row level security;
alter table public.notification_events enable row level security;

create policy notification_channels_admin_read
  on public.notification_channels
  for select
  using (public.is_admin(auth.uid()));

create policy notification_channels_admin_write
  on public.notification_channels
  for all
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

create policy notification_events_admin_read
  on public.notification_events
  for select
  using (public.is_admin(auth.uid()));

create policy notification_events_admin_write
  on public.notification_events
  for all
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- Helper view summarising recent notification deliveries
create or replace view public.notification_event_summaries as
select
  e.id,
  e.created_at,
  e.dispatched_at,
  e.status,
  e.error,
  e.ticker,
  e.conviction,
  e.verdict,
  e.ensemble_score,
  e.stage,
  e.run_id,
  c.label as channel_label,
  c.type as channel_type,
  c.target as channel_target
from public.notification_events e
left join public.notification_channels c on c.id = e.channel_id;
