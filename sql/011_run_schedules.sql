create table if not exists run_schedules (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references runs(id) on delete cascade,
  label text,
  cadence_seconds integer not null default 3600 check (cadence_seconds >= 60),
  stage1_limit integer not null default 8 check (stage1_limit between 1 and 25),
  stage2_limit integer not null default 4 check (stage2_limit between 1 and 25),
  stage3_limit integer not null default 2 check (stage3_limit between 1 and 25),
  max_cycles integer not null default 1 check (max_cycles >= 1 and max_cycles <= 10),
  active boolean not null default true,
  last_triggered_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint run_schedules_run_id_unique unique (run_id)
);

create index if not exists run_schedules_active_idx on run_schedules (active) where active = true;
create index if not exists run_schedules_last_triggered_idx on run_schedules (last_triggered_at);
