# Supabase migration playbook

This project keeps its database schema under the `/sql` directory. Each file is a
Supabase-compatible migration that can be applied with `supabase db push`, `supabase
migration up`, or any PostgreSQL client that runs the statements in order.

## When to run migrations

- **Fresh environment** — run all scripts sequentially (`supabase db reset` is the
  quickest way) so the base tables, helper functions, and seeds exist.
- **After pulling new SQL changes** — apply only the migrations that changed in your
  diff. Every file is idempotent, so re-running one you already applied is safe.
- **Local testing of seeds** — if you tweak the seeded data, re-run that specific
  migration to load the latest values.

## Recent changes

- `sql/014_cached_completions.sql` provisions the cache that Stage 1–3 workers
  consult before calling the model. Run it before deploying the cached response
  helpers so reuse works end to end.
- `sql/013_watchlists.sql` introduces watchlists, ticker events, and helper
  functions/policies. Apply it before deploying the planner scope UI or the
  `tickers-refresh` worker.
- `sql/006_ai_registry.sql` now keeps its `ON CONFLICT` clause attached to the seeded
  `INSERT` statement. Re-run it only if you want the corrected upsert logic in your
  database.
- `sql/007_question_registry.sql` replaced Python-style `[...]` literals with
  `jsonb_build_array(...)` calls inside the dimension metadata seeds. Apply the
  migration if you have not run it since that fix.
- `sql/016_scoring_ensembles.sql` adds the deterministic factor registry, ticker
  factor snapshots, and new ensemble columns on `analysis_dimension_scores`.
  Run it before deploying the updated Stage 3 worker so Supabase has the tables
  and view the code expects.
- `sql/017_notifications.sql` provisions `notification_channels`,
  `notification_events`, and the supporting policies/view required for Stage 3
  alerting. Run it before deploying the notification helper so planner admins
  can configure email/Slack channels.

## Suggested commands

```
# reset the full schema (drops and recreates everything)
npm run db:reset

# apply migrations that have not been run yet
npm run db:push

# run an individual script
psql "$SUPABASE_DB_URL" -f sql/007_question_registry.sql
```

> **Tip:** the seeds in `006` and `007` are idempotent. If you need to rerun them,
> simply execute the files again; the `ON CONFLICT` clauses keep data up to date without
> creating duplicates.
