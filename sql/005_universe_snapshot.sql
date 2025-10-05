-- Universe snapshot helpers for run exploration and ticker drilldowns
-- These routines can be re-run safely (create or replace).

create or replace function public.run_universe_rows(
  p_run_id uuid,
  p_search text default null,
  p_label text default null,
  p_stage int default null,
  p_sector text default null,
  p_go_deep boolean default null,
  p_status text default null,
  p_limit integer default 100,
  p_offset integer default 0
)
returns table(
  run_id uuid,
  ticker text,
  name text,
  exchange text,
  country text,
  sector text,
  industry text,
  stage int,
  status text,
  label text,
  stage2_go_deep boolean,
  spend_usd numeric,
  updated_at timestamptz,
  stage1 jsonb,
  stage2 jsonb,
  stage3 jsonb,
  stage3_summary text,
  total_count bigint
)
language sql
stable
as $$
  with base as (
    select
      ri.run_id,
      ri.ticker,
      t.name,
      t.exchange,
      t.country,
      t.sector,
      t.industry,
      coalesce(ri.stage, 0) as stage,
      ri.status,
      coalesce(ri.label, '') as label,
      coalesce(ri.stage2_go_deep, false) as stage2_go_deep,
      coalesce(ri.spend_est_usd, 0)::numeric(12,4) as spend_usd,
      ri.updated_at
    from public.run_items ri
    join public.tickers t on t.ticker = ri.ticker
    where ri.run_id = p_run_id
      and (p_status is null or ri.status = p_status)
      and (p_stage is null or coalesce(ri.stage, 0) = p_stage)
      and (p_label is null or lower(coalesce(ri.label, '')) = lower(p_label))
      and (p_go_deep is null or coalesce(ri.stage2_go_deep, false) = p_go_deep)
      and (p_sector is null or lower(coalesce(t.sector, '')) = lower(p_sector))
      and (
        p_search is null
        or p_search = ''
        or t.ticker ilike '%' || p_search || '%'
        or t.name ilike '%' || p_search || '%'
      )
  )
  select
    base.run_id,
    base.ticker,
    base.name,
    base.exchange,
    base.country,
    base.sector,
    base.industry,
    base.stage,
    base.status,
    base.label,
    base.stage2_go_deep,
    base.spend_usd,
    base.updated_at,
    stage1.answer_json as stage1,
    stage2.answer_json as stage2,
    stage3_summary.answer_json as stage3,
    coalesce(stage3_summary.answer_text, stage3_summary.answer_json ->> 'summary') as stage3_summary,
    count(*) over () as total_count
  from base
  left join lateral (
    select answer_json
      from public.answers
     where run_id = base.run_id
       and ticker = base.ticker
       and stage = 1
     order by created_at desc
     limit 1
  ) stage1 on true
  left join lateral (
    select answer_json
      from public.answers
     where run_id = base.run_id
       and ticker = base.ticker
       and stage = 2
     order by created_at desc
     limit 1
  ) stage2 on true
  left join lateral (
    select answer_json, answer_text
      from public.answers
     where run_id = base.run_id
       and ticker = base.ticker
       and stage = 3
       and coalesce(question_group, '') = 'summary'
     order by created_at desc
     limit 1
  ) stage3_summary on true
  order by base.stage desc, base.status asc, base.label asc, base.ticker
  limit least(greatest(coalesce(p_limit, 100), 1), 500)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

create or replace function public.run_universe_facets(
  p_run_id uuid,
  p_search text default null,
  p_label text default null,
  p_stage int default null,
  p_sector text default null,
  p_go_deep boolean default null,
  p_status text default null
)
returns table(metric text, bucket text, total bigint)
language sql
stable
as $$
  with filtered as (
    select
      ri.run_id,
      ri.ticker,
      coalesce(ri.stage, 0) as stage,
      coalesce(ri.label, '') as label,
      ri.status,
      coalesce(ri.stage2_go_deep, false) as stage2_go_deep,
      t.sector
    from public.run_items ri
    join public.tickers t on t.ticker = ri.ticker
    where ri.run_id = p_run_id
      and (p_status is null or ri.status = p_status)
      and (p_stage is null or coalesce(ri.stage, 0) = p_stage)
      and (p_label is null or lower(coalesce(ri.label, '')) = lower(p_label))
      and (p_go_deep is null or coalesce(ri.stage2_go_deep, false) = p_go_deep)
      and (p_sector is null or lower(coalesce(t.sector, '')) = lower(p_sector))
      and (
        p_search is null
        or p_search = ''
        or t.ticker ilike '%' || p_search || '%'
        or t.name ilike '%' || p_search || '%'
      )
  )
  select 'stage' as metric, stage::text as bucket, count(*)::bigint as total
    from filtered
   group by stage
  union all
  select 'label' as metric, nullif(label, '') as bucket, count(*)::bigint as total
    from filtered
   group by nullif(label, '')
  union all
  select 'status' as metric, status as bucket, count(*)::bigint as total
    from filtered
   group by status
  union all
  select 'sector' as metric, nullif(sector, '') as bucket, count(*)::bigint as total
    from filtered
   group by nullif(sector, '')
  union all
  select 'go_deep' as metric, case when stage2_go_deep then 'true' else 'false' end as bucket, count(*)::bigint as total
    from filtered
   group by stage2_go_deep;
$$;

create or replace function public.run_ticker_details(
  p_run_id uuid,
  p_ticker text
)
returns table(
  run_id uuid,
  ticker text,
  name text,
  exchange text,
  country text,
  sector text,
  industry text,
  stage int,
  status text,
  label text,
  stage2_go_deep boolean,
  spend_usd numeric,
  updated_at timestamptz,
  stage1 jsonb,
  stage2 jsonb,
  stage3_summary jsonb,
  stage3_text text,
  stage3_groups jsonb
)
language sql
stable
as $$
  with base as (
    select
      ri.run_id,
      ri.ticker,
      t.name,
      t.exchange,
      t.country,
      t.sector,
      t.industry,
      coalesce(ri.stage, 0) as stage,
      ri.status,
      coalesce(ri.label, '') as label,
      coalesce(ri.stage2_go_deep, false) as stage2_go_deep,
      coalesce(ri.spend_est_usd, 0)::numeric(12,4) as spend_usd,
      ri.updated_at
    from public.run_items ri
    join public.tickers t on t.ticker = ri.ticker
    where ri.run_id = p_run_id
      and ri.ticker = p_ticker
    limit 1
  ),
  stage1 as (
    select answer_json
      from public.answers
     where run_id = p_run_id
       and ticker = p_ticker
       and stage = 1
     order by created_at desc
     limit 1
  ),
  stage2 as (
    select answer_json
      from public.answers
     where run_id = p_run_id
       and ticker = p_ticker
       and stage = 2
     order by created_at desc
     limit 1
  ),
  stage3_summary as (
    select answer_json, answer_text
      from public.answers
     where run_id = p_run_id
       and ticker = p_ticker
       and stage = 3
       and coalesce(question_group, '') = 'summary'
     order by created_at desc
     limit 1
  ),
  stage3_groups as (
    select coalesce(jsonb_agg(jsonb_build_object(
        'question_group', question_group,
        'answer_json', answer_json,
        'created_at', created_at
      ) order by created_at desc), '[]'::jsonb) as groups
      from public.answers
     where run_id = p_run_id
       and ticker = p_ticker
       and stage = 3
       and coalesce(question_group, '') <> 'summary'
  )
  select
    base.run_id,
    base.ticker,
    base.name,
    base.exchange,
    base.country,
    base.sector,
    base.industry,
    base.stage,
    base.status,
    base.label,
    base.stage2_go_deep,
    base.spend_usd,
    base.updated_at,
    stage1.answer_json as stage1,
    stage2.answer_json as stage2,
    stage3_summary.answer_json as stage3_summary,
    coalesce(stage3_summary.answer_text, stage3_summary.answer_json ->> 'summary') as stage3_text,
    stage3_groups.groups as stage3_groups
  from base
  left join stage1 on true
  left join stage2 on true
  left join stage3_summary on true
  left join stage3_groups on true;
$$;
