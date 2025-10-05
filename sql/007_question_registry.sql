-- Analysis dimension & question registry for staged automation
-- Idempotent: safe to rerun.

create table if not exists public.analysis_dimensions (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  description text,
  stage int not null default 3,
  order_index int not null default 0,
  weight numeric(8,4) not null default 1,
  color_bad text not null default '#c0392b',
  color_neutral text not null default '#f39c12',
  color_good text not null default '#27ae60',
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists analysis_dimensions_stage_idx
  on public.analysis_dimensions (stage, order_index);

create table if not exists public.analysis_questions (
  id uuid primary key default gen_random_uuid(),
  dimension_id uuid not null references public.analysis_dimensions(id) on delete cascade,
  slug text unique not null,
  stage int not null default 3,
  order_index int not null default 0,
  prompt text not null,
  guidance text,
  weight numeric(8,4) not null default 1,
  answer_schema jsonb not null default jsonb_build_object(
    'question', 'string',
    'verdict', 'bad|neutral|good',
    'score', jsonb_build_object('type', 'number', 'min', 0, 'max', 100),
    'summary', 'string',
    'signals', jsonb_build_array(),
    'tags', jsonb_build_array()
  ),
  depends_on text[] not null default '{}',
  tags text[] not null default '{}',
  is_active boolean not null default true,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists analysis_questions_dimension_idx
  on public.analysis_questions (dimension_id, stage, order_index);

create table if not exists public.analysis_question_results (
  run_id uuid not null references public.runs(id) on delete cascade,
  ticker text not null references public.tickers(ticker) on delete cascade,
  question_id uuid not null references public.analysis_questions(id) on delete cascade,
  question_slug text not null,
  dimension_id uuid not null references public.analysis_dimensions(id) on delete cascade,
  stage int not null,
  verdict text,
  score numeric(8,4),
  weight numeric(8,4) not null default 1,
  color text,
  summary text,
  answer jsonb,
  tags text[] default '{}',
  dependencies text[] default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (run_id, ticker, question_id)
);

create index if not exists analysis_question_results_dimension_idx
  on public.analysis_question_results (run_id, ticker, dimension_id);

create table if not exists public.analysis_dimension_scores (
  run_id uuid not null references public.runs(id) on delete cascade,
  ticker text not null references public.tickers(ticker) on delete cascade,
  dimension_id uuid not null references public.analysis_dimensions(id) on delete cascade,
  verdict text,
  score numeric(8,4),
  weight numeric(8,4) not null default 1,
  color text,
  summary text,
  tags text[] default '{}',
  details jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (run_id, ticker, dimension_id)
);

create index if not exists analysis_dimension_scores_run_idx
  on public.analysis_dimension_scores (run_id, ticker);

-- Seed canonical dimensions (safe upsert)
insert into public.analysis_dimensions (slug, name, description, stage, order_index, weight, metadata)
values
  (
    'financial_resilience',
    'Financial Resilience',
    'Liquidity, leverage, and capital discipline including debt servicing and capital allocation flex.',
    3,
    10,
    1.2,
    jsonb_build_object('signals', jsonb_build_array('leverage', 'cash_flow', 'credit'))
  ),
  (
    'market_positioning',
    'Market Positioning',
    'Competitive moat, segment leadership, and hyperscale or cannibal dynamics vs. direct peers.',
    3,
    20,
    1.1,
    jsonb_build_object('signals', jsonb_build_array('moat', 'share', 'hyperscale'))
  ),
  (
    'leadership_competency',
    'Leadership & Governance',
    'Quality of leadership, board oversight, capital deployment judgement, and track record.',
    3,
    30,
    1.0,
    jsonb_build_object('signals', jsonb_build_array('track_record', 'governance', 'execution'))
  ),
  (
    'product_relevance',
    'Product & Innovation Fitness',
    'Product velocity, customer love, roadmap relevance, and alignment to secular demand shifts.',
    3,
    40,
    1.0,
    jsonb_build_object('signals', jsonb_build_array('innovation', 'differentiation'))
  ),
  (
    'resilience_risk',
    'Resilience & Macro Readiness',
    'Operational resilience, supply chain, macro sensitivity, and situational awareness (pandemics, shocks).',
    3,
    50,
    0.9,
    jsonb_build_object('signals', jsonb_build_array('macro', 'supply_chain', 'scenario'))
  )
on conflict (slug) do update
  set name = excluded.name,
      description = excluded.description,
      stage = excluded.stage,
      order_index = excluded.order_index,
      weight = excluded.weight,
      metadata = excluded.metadata,
      updated_at = now();

-- Seed representative questions (safe upsert)
insert into public.analysis_questions (
  dimension_id,
  slug,
  stage,
  order_index,
  prompt,
  guidance,
  weight,
  answer_schema,
  depends_on,
  tags
)
select d.id,
       q.slug,
       q.stage,
       q.order_index,
       q.prompt,
       q.guidance,
       q.weight,
       q.answer_schema,
       q.depends_on,
       q.tags
from public.analysis_dimensions d
join (
  values
    ('financial_resilience', 'fin_core_liquidity', 3, 10,
      'Synthesize liquidity, debt structure, covenant headroom, and credit market perception. Consider leverage trends, maturities, refinancing hurdles, and any off-balance exposures.',
      'Quantify ability to weather stress over 12-36 months. Contrast debt load versus peers and flag structural weak points.',
      1.2,
      jsonb_build_object(
        'question', 'fin_core_liquidity',
        'verdict', 'bad|neutral|good',
        'score', jsonb_build_object('type', 'number', 'min', 0, 'max', 100),
        'summary', 'string',
        'signals', jsonb_build_array(),
        'tags', jsonb_build_array('leverage','liquidity','credit')
      ),
      array[]::text[],
      array['debt','liquidity','credit']
    ),
    ('financial_resilience', 'fin_operating_shock', 3, 20,
      'Evaluate how operating leverage, working capital cycle, and margin structure respond under stress (pandemics, supply shocks).',
      'Reference historic downturns or case studies. Highlight resilience mechanisms or fragilities.',
      1.0,
      jsonb_build_object(
        'question', 'fin_operating_shock',
        'verdict', 'bad|neutral|good',
        'score', jsonb_build_object('type', 'number', 'min', 0, 'max', 100),
        'summary', 'string',
        'signals', jsonb_build_array(),
        'tags', jsonb_build_array('resilience','margin','scenario')
      ),
      array['fin_core_liquidity'],
      array['pandemic','stress_test']
    ),
    ('market_positioning', 'market_segments_competitors', 3, 10,
      'Map revenue segments, peer set, and competitive response. Identify cannibal, hyperscale, or niche leadership situations.',
      'Score the company on durable market share retention vs. direct peers. Cite quantifiable signals where possible.',
      1.1,
      jsonb_build_object(
        'question', 'market_segments_competitors',
        'verdict', 'bad|neutral|good',
        'score', jsonb_build_object('type', 'number', 'min', 0, 'max', 100),
        'summary', 'string',
        'signals', jsonb_build_array(),
        'tags', jsonb_build_array('competition','moat','hyperscale')
      ),
      array[]::text[],
      array['segments','competitors']
    ),
    ('market_positioning', 'market_playbook_alignment', 3, 20,
      'Assess go-to-market and pricing power relative to customer needs. Include geographic or channel nuances.',
      'Point out demand elasticity and customer stickiness. Connect to Stage 2 profitability/timing outputs.',
      0.9,
      jsonb_build_object(
        'question', 'market_playbook_alignment',
        'verdict', 'bad|neutral|good',
        'score', jsonb_build_object('type', 'number', 'min', 0, 'max', 100),
        'summary', 'string',
        'signals', jsonb_build_array(),
        'tags', jsonb_build_array('pricing','customer','moat')
      ),
      array['market_segments_competitors'],
      array['pricing','demand']
    ),
    ('leadership_competency', 'leadership_experience_vector', 3, 10,
      'Analyze leadership and board effectiveness, capital allocation record, and cultural indicators.',
      'Compare leadership cadence vs. sector expectations. Highlight execution proofs or governance gaps.',
      1.0,
      jsonb_build_object(
        'question', 'leadership_experience_vector',
        'verdict', 'bad|neutral|good',
        'score', jsonb_build_object('type', 'number', 'min', 0, 'max', 100),
        'summary', 'string',
        'signals', jsonb_build_array(),
        'tags', jsonb_build_array('leadership','board','culture')
      ),
      array[]::text[],
      array['leadership','governance']
    ),
    ('product_relevance', 'product_innovation_pipeline', 3, 10,
      'Evaluate product roadmap, innovation cadence, and customer adoption signals. Highlight moats derived from tech or data.',
      'Score ability to stay relevant over 2-4 years. Capture dependencies on key launches or platform transitions.',
      1.0,
      jsonb_build_object(
        'question', 'product_innovation_pipeline',
        'verdict', 'bad|neutral|good',
        'score', jsonb_build_object('type', 'number', 'min', 0, 'max', 100),
        'summary', 'string',
        'signals', jsonb_build_array(),
        'tags', jsonb_build_array('product','innovation','roadmap')
      ),
      array['market_segments_competitors'],
      array['product','innovation']
    ),
    ('resilience_risk', 'macro_risk_matrix', 3, 10,
      'Synthesize macro, regulatory, geopolitical, and tail-risk exposures. Flag correlations to known shocks.',
      'Incorporate Stage 2 timing/risk outputs plus any retrieved filings or news. Identify monitoring triggers.',
      0.9,
      jsonb_build_object(
        'question', 'macro_risk_matrix',
        'verdict', 'bad|neutral|good',
        'score', jsonb_build_object('type', 'number', 'min', 0, 'max', 100),
        'summary', 'string',
        'signals', jsonb_build_array(),
        'tags', jsonb_build_array('macro','regulation','tail_risk')
      ),
      array['fin_operating_shock','market_segments_competitors'],
      array['macro','tail_risk']
    )
) as q(slug_dimension, slug, stage, order_index, prompt, guidance, weight, answer_schema, depends_on, tags)
  on d.slug = q.slug_dimension
on conflict (slug) do update
  set dimension_id = excluded.dimension_id,
      stage = excluded.stage,
      order_index = excluded.order_index,
      prompt = excluded.prompt,
      guidance = excluded.guidance,
      weight = excluded.weight,
      answer_schema = excluded.answer_schema,
      depends_on = excluded.depends_on,
      tags = excluded.tags,
      updated_at = now();

