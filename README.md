# FutureFunds.ai site

This repository hosts the static marketing and member experience for FutureFunds.ai. The
pages under `/assets` provide the interactive logic for authentication, the research
universe, and internal tooling.

## Getting started

1. Copy `.env.example` to `.env` and supply your Supabase URL, anon key,
   service role key, and model credentials. Mirror these values inside the
   Supabase dashboard (`Project Settings → Configuration → Secrets`) so deployed
   edge functions can read them.
2. Install the [Supabase CLI](https://supabase.com/docs/reference/cli/overview)
   and authenticate with `supabase login`. The included `package.json` exposes
   helper commands such as `npm run db:push` and `npm run functions:deploy` to
   bootstrap a new environment quickly.
3. Work through the [first run checklist](docs/first-run-checklist.md) to apply
   the SQL migrations, deploy the edge functions, and exercise the planner UI
   before enabling unattended schedules.
4. Decide how you want to maintain the ticker universe:
   - Use the planner’s watchlist tools to curate focused lists that runs can
     target directly.
   - Configure the `tickers-refresh` worker with a roster feed (or let it infer
     updates from the planner) so new tickers, renames, and delistings are
     captured automatically.
5. Tune the cached completion TTLs if desired. The defaults keep deterministic
   Stage 1–3 prompts for seven days (`AI_CACHE_TTL_MINUTES`); override the stage
   specific env vars when you need shorter or longer retention.

## Developer docs

- [Supabase database reference](docs/supabase-schema.md) — canonical contract for the
  tables, policies, and triggers the frontend expects.
- [Migration playbook](docs/migration-playbook.md) — when to re-run the SQL files and
  the commands we use in Supabase.
- [Automated equity analyst roadmap](docs/equity-analyst-roadmap.md) — phased build plan for the
  multi-stage research system and associated UI.
- [Ticker roster maintenance](docs/supabase-schema.md#tickers) — describes the
  `tickers-refresh` worker, watchlists, and the policies backing the planner’s
  new scope controls.
- [LLM response cache](docs/supabase-schema.md#cached_completions) — explains how
  Stage 1–3 workers reuse deterministic prompts via the `cached_completions`
  table and the associated TTL environment variables.
- [Sector prompt library](sectors.html) — admin console to curate Stage 2 heuristics synced to the planner.
- [Universe cockpit](universe.html) — requires the helper functions from `sql/003_dashboard_helpers.sql`
  and `sql/005_universe_snapshot.sql` to surface run outputs and ticker dossiers.
- Question + scoring registry lives in `sql/007_question_registry.sql`; apply it after the
  core schema so Stage&nbsp;3 workers can resolve dimensions, dependency graphs, and
  weighted scorecards.
- Database migrations live under `/sql` (apply them with `supabase db push` or your preferred
  migration runner).
