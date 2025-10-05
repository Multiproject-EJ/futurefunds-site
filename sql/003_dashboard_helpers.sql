-- Helper routines for the analyst command center dashboard
-- These functions are idempotent (create or replace) so they can be applied safely.

create or replace function public.run_stage_status_counts(p_run_id uuid)
returns table(stage int, status text, total bigint)
language sql
stable
as $$
  select coalesce(stage, 0) as stage,
         status,
         count(*)::bigint as total
    from public.run_items
   where run_id = p_run_id
   group by coalesce(stage, 0), status
   order by coalesce(stage, 0), status;
$$;

create or replace function public.run_stage1_labels(p_run_id uuid)
returns table(label text, total bigint)
language sql
stable
as $$
  select coalesce(nullif(label, ''), 'Unlabeled') as label,
         count(*)::bigint as total
    from public.run_items
   where run_id = p_run_id
     and stage >= 1
     and status = 'ok'
   group by coalesce(nullif(label, ''), 'Unlabeled')
   order by total desc, label asc;
$$;

create or replace function public.run_cost_breakdown(p_run_id uuid)
returns table(stage int, model text, tokens_in bigint, tokens_out bigint, cost_usd numeric)
language sql
stable
as $$
  select stage,
         model,
         coalesce(sum(tokens_in), 0)::bigint      as tokens_in,
         coalesce(sum(tokens_out), 0)::bigint     as tokens_out,
         coalesce(sum(cost_usd), 0)::numeric(12,4) as cost_usd
    from public.cost_ledger
   where run_id = p_run_id
   group by stage, model
   order by stage, model;
$$;

create or replace function public.run_cost_summary(p_run_id uuid)
returns table(total_cost numeric, total_tokens_in bigint, total_tokens_out bigint)
language sql
stable
as $$
  select coalesce(sum(cost_usd), 0)::numeric(12,4) as total_cost,
         coalesce(sum(tokens_in), 0)::bigint       as total_tokens_in,
         coalesce(sum(tokens_out), 0)::bigint      as total_tokens_out
    from public.cost_ledger
   where run_id = p_run_id;
$$;

create or replace function public.run_latest_activity(p_run_id uuid, p_limit integer default 10)
returns table(ticker text, stage int, question_group text, created_at timestamptz, label text, summary text)
language sql
stable
as $$
  select a.ticker,
         coalesce(a.stage, 0) as stage,
         coalesce(a.question_group, '—') as question_group,
         a.created_at,
         ri.label,
         coalesce(
           a.answer_json ->> 'summary',
           case
             when jsonb_typeof(a.answer_json -> 'reasons') = 'array' then
               array_to_string(array(select jsonb_array_elements_text(a.answer_json -> 'reasons') limit 1), '; ')
             else null
           end,
           nullif(trim(both '"' from left(a.answer_json::text, 200)), ''),
           left(coalesce(a.answer_text, ''), 200)
         ) as summary
    from public.answers a
    left join public.run_items ri
      on ri.run_id = a.run_id
     and ri.ticker = a.ticker
   where a.run_id = p_run_id
   order by a.created_at desc
   limit greatest(p_limit, 1);
$$;

create or replace function public.run_stage2_summary(p_run_id uuid)
returns table(
  total_survivors bigint,
  pending bigint,
  completed bigint,
  failed bigint,
  go_deep bigint
)
language sql
stable
as $$
  with survivors as (
    select run_id,
           ticker,
           stage,
           status,
           lower(coalesce(label, '')) as normalized_label,
           coalesce(stage2_go_deep, false) as stage2_go_deep
      from public.run_items
     where run_id = p_run_id
       and status <> 'skipped'
  ),
  filtered as (
    select *
      from survivors
     where normalized_label in ('consider', 'borderline')
  )
  select count(*)::bigint as total_survivors,
         count(*) filter (where stage = 1 and status = 'ok')::bigint as pending,
         count(*) filter (where stage >= 2 and status = 'ok')::bigint as completed,
         count(*) filter (where stage >= 2 and status = 'failed')::bigint as failed,
         count(*) filter (where stage >= 2 and status = 'ok' and stage2_go_deep)::bigint as go_deep
    from filtered;
$$;

