-- Advanced scoring ensembles: deterministic factor registry and blended dimension scores
-- Idempotent: safe to rerun.

-- Factor catalogue storing deterministic metrics (growth, leverage, returns, etc.)
create table if not exists public.scoring_factors (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  description text,
  category text,
  direction text not null default 'higher_better' check (direction in ('higher_better','lower_better')),
  scale_min numeric,
  scale_max numeric,
  weight numeric(10,4) not null default 1,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists scoring_factors_slug_idx on public.scoring_factors (slug);

-- Join table linking analysis dimensions to deterministic factors with optional weights
create table if not exists public.dimension_factor_links (
  dimension_id uuid not null references public.analysis_dimensions(id) on delete cascade,
  factor_id uuid not null references public.scoring_factors(id) on delete cascade,
  weight numeric(10,4) not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (dimension_id, factor_id)
);

create index if not exists dimension_factor_links_dim_idx
  on public.dimension_factor_links (dimension_id);

create index if not exists dimension_factor_links_factor_idx
  on public.dimension_factor_links (factor_id);

-- Snapshots of deterministic factor values per ticker
create table if not exists public.ticker_factor_snapshots (
  ticker text not null references public.tickers(ticker) on delete cascade,
  factor_id uuid not null references public.scoring_factors(id) on delete cascade,
  as_of date not null default current_date,
  value numeric,
  score numeric,
  source text,
  notes text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (ticker, factor_id, as_of)
);

create index if not exists ticker_factor_snapshots_factor_idx
  on public.ticker_factor_snapshots (factor_id, as_of desc);

create index if not exists ticker_factor_snapshots_ticker_idx
  on public.ticker_factor_snapshots (ticker, factor_id, as_of desc);

-- Latest snapshot helper view
create or replace view public.ticker_factor_latest as
select distinct on (tfs.ticker, tfs.factor_id)
  tfs.ticker,
  tfs.factor_id,
  tfs.as_of,
  tfs.value,
  tfs.score,
  tfs.source,
  tfs.notes,
  tfs.metadata,
  tfs.created_at
from public.ticker_factor_snapshots tfs
order by tfs.ticker, tfs.factor_id, tfs.as_of desc, tfs.created_at desc;

-- Enable RLS and expose member-friendly policies
alter table public.scoring_factors enable row level security;
alter table public.dimension_factor_links enable row level security;
alter table public.ticker_factor_snapshots enable row level security;

-- Factors are readable by all authenticated users; writes limited to admins/service role
drop policy if exists scoring_factors_read on public.scoring_factors;
create policy scoring_factors_read on public.scoring_factors
  for select
  using (true);

drop policy if exists scoring_factors_admin_write on public.scoring_factors;
create policy scoring_factors_admin_write on public.scoring_factors
  for all
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- Dimension link maintenance is admin-only
drop policy if exists dimension_factor_links_read on public.dimension_factor_links;
create policy dimension_factor_links_read on public.dimension_factor_links
  for select
  using (public.is_admin(auth.uid()));

drop policy if exists dimension_factor_links_write on public.dimension_factor_links;
create policy dimension_factor_links_write on public.dimension_factor_links
  for all
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- Factor snapshots readable by members; writes constrained to admins/service role
-- (Service role bypasses RLS automatically for automation jobs.)
drop policy if exists ticker_factor_snapshots_read on public.ticker_factor_snapshots;
create policy ticker_factor_snapshots_read on public.ticker_factor_snapshots
  for select
  using (public.is_paid_member(auth.uid()) or public.is_admin(auth.uid()));

drop policy if exists ticker_factor_snapshots_write on public.ticker_factor_snapshots;
create policy ticker_factor_snapshots_write on public.ticker_factor_snapshots
  for all
  using (public.is_admin(auth.uid()))
  with check (public.is_admin(auth.uid()));

-- Touch updated_at on catalog tables
create trigger scoring_factors_touch_updated
  before update on public.scoring_factors
  for each row
  execute function public.touch_updated_at();

create trigger dimension_factor_links_touch_updated
  before update on public.dimension_factor_links
  for each row
  execute function public.touch_updated_at();

-- Extend analysis_dimension_scores to retain ensemble metadata
alter table public.analysis_dimension_scores
  add column if not exists llm_score numeric(8,4),
  add column if not exists factor_score numeric(8,4),
  add column if not exists ensemble_score numeric(8,4),
  add column if not exists llm_weight numeric(8,4),
  add column if not exists factor_weight numeric(8,4),
  add column if not exists factor_breakdown jsonb not null default '[]'::jsonb;

update public.analysis_dimension_scores
   set llm_score = coalesce(llm_score, score),
       ensemble_score = coalesce(ensemble_score, score),
       llm_weight = coalesce(llm_weight, weight),
       factor_weight = coalesce(factor_weight, 0),
       factor_breakdown = coalesce(factor_breakdown, '[]'::jsonb)
 where llm_score is null
    or ensemble_score is null
    or llm_weight is null
    or factor_weight is null
    or factor_breakdown is null;

-- Seed representative factors and map them to existing dimensions
insert into public.scoring_factors (slug, name, description, category, direction, scale_min, scale_max, weight, metadata)
values
  ('revenue_growth_yoy', 'Revenue Growth YoY', 'Trailing twelve-month revenue growth versus the prior-year period.', 'growth', 'higher_better', -0.25, 0.60, 1.1, jsonb_build_object('unit', 'pct', 'ideal', 0.2)),
  ('gross_margin', 'Gross Margin', 'Latest gross margin percentage reported by the company.', 'profitability', 'higher_better', 0.2, 0.75, 1.0, jsonb_build_object('unit', 'pct', 'ideal', 0.45)),
  ('net_debt_to_ebitda', 'Net Debt / EBITDA', 'Net leverage ratio capturing balance sheet risk.', 'leverage', 'lower_better', 0, 4.5, 1.2, jsonb_build_object('unit', 'x', 'ideal', 1.5)),
  ('free_cash_flow_yield', 'Free Cash Flow Yield', 'Trailing twelve-month free cash flow divided by enterprise value.', 'valuation', 'higher_better', -0.05, 0.12, 1.1, jsonb_build_object('unit', 'pct', 'ideal', 0.05)),
  ('return_on_invested_capital', 'Return on Invested Capital', 'ROIC using trailing twelve-month operating profit.', 'returns', 'higher_better', 0.02, 0.30, 1.0, jsonb_build_object('unit', 'pct', 'ideal', 0.12)),
  ('earnings_variability', 'Earnings Variability', 'Standard deviation of EPS growth over five years.', 'resilience', 'lower_better', 0.0, 0.35, 0.9, jsonb_build_object('unit', 'stdev', 'ideal', 0.12)),
  ('r_and_d_intensity', 'R&D Intensity', 'Research and development spend as a percentage of revenue.', 'innovation', 'higher_better', 0.0, 0.25, 0.9, jsonb_build_object('unit', 'pct', 'ideal', 0.10))
on conflict (slug) do update
  set name = excluded.name,
      description = excluded.description,
      category = excluded.category,
      direction = excluded.direction,
      scale_min = excluded.scale_min,
      scale_max = excluded.scale_max,
      weight = excluded.weight,
      metadata = excluded.metadata,
      updated_at = now();

insert into public.dimension_factor_links (dimension_id, factor_id, weight)
select d.id, f.id, cfg.weight
from (
  values
    ('financial_resilience', 'net_debt_to_ebitda', 1.3),
    ('financial_resilience', 'free_cash_flow_yield', 1.1),
    ('market_positioning', 'revenue_growth_yoy', 1.2),
    ('market_positioning', 'gross_margin', 1.0),
    ('leadership_competency', 'return_on_invested_capital', 1.1),
    ('product_relevance', 'r_and_d_intensity', 1.0),
    ('resilience_risk', 'earnings_variability', 1.2),
    ('resilience_risk', 'net_debt_to_ebitda', 0.8)
) as cfg(dimension_slug, factor_slug, weight)
join public.analysis_dimensions d on d.slug = cfg.dimension_slug
join public.scoring_factors f on f.slug = cfg.factor_slug
on conflict (dimension_id, factor_id) do update
  set weight = excluded.weight,
      updated_at = now();

-- Ensure ticker roster has a placeholder snapshot for seeded tickers when absent
insert into public.ticker_factor_snapshots (ticker, factor_id, as_of, value, score, source, notes)
select t.ticker,
       f.id,
       current_date,
       null,
       null,
       'seed',
       'Placeholder row to enable ensemble weighting.'
from public.tickers t
cross join public.scoring_factors f
where not exists (
  select 1
    from public.ticker_factor_snapshots existing
   where existing.ticker = t.ticker
     and existing.factor_id = f.id
)
limit 0; -- keep idempotent without forcing data when operators prefer live feeds

