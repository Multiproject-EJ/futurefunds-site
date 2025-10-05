-- Stage 2 rollout adjustments
-- Safe to run multiple times; adds the go-deep column and ensures helper function is up to date.

alter table if exists public.run_items
  add column if not exists stage2_go_deep boolean;

-- Ensure the Stage 2 summary helper exists with the latest definition.
\i ./003_dashboard_helpers.sql
