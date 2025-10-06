# First automated run checklist

This guide walks through everything required to move the FutureFunds analyst
workflow from a freshly cloned repository to its first unattended run. Work
through each section in order—once all boxes are checked you can let the
scheduler drive hourly batches on your Supabase project.

## 1. Install tooling

- [ ] Install the [Supabase CLI](https://supabase.com/docs/reference/cli/overview)
      (v1.171 or newer) on the machine that will run migrations and deploy edge
      functions.
- [ ] Install [Deno](https://deno.land/#installation) if you plan to execute the
      edge functions locally with `supabase functions serve`.
- [ ] Ensure you have an OpenAI (and/or OpenRouter) account with API access.

## 2. Configure environment secrets

1. Copy `.env.example` to `.env` and populate each value with the credentials for
   your Supabase project and model providers. If you plan to run the roster
   refresher, also add `TICKER_FEED_URL` (and optionally `TICKER_FEED_API_KEY`).
2. Run `supabase login` and authenticate with the same account that owns the
   project.
3. Export the project reference for convenience when running CLI commands:

   ```bash
   export SUPABASE_PROJECT_REF=your-project-ref
   ```

4. Store the same secrets inside the Supabase dashboard so the deployed edge
   functions can read them (`Project Settings → Configuration → Secrets`).

## 3. Apply database schema and seeds

- [ ] Run `npm run db:reset` (destroys and recreates everything) or
      `npm run db:push` to apply the SQL files under `/sql` in order. The core
      schema lives in `001_core.sql` and includes the tables consumed by the
      edge workers. `013_watchlists.sql` adds the roster/watchlist tables used by
      the new planner scope controls and `014_cached_completions.sql` provisions
      the response cache reused by Stage 1–3.
- [ ] Confirm the seed data exists: `tickers`, `sector_prompts`, and the question
      registry should all contain rows once migrations finish.

> **Tip:** set `SUPABASE_DB_URL` in your `.env` when using psql locally. The
> scripts are idempotent, so re-running them is safe if you need to refresh
> seeds or helper functions later.

## 4. Deploy edge functions

1. Run `npm run functions:deploy` to push the automation handlers to Supabase.
   This deploys `runs-create`, `runs-continue`, the stage consumers, scheduler,
   feedback endpoints, health checks, document ingest worker, and the new
   `tickers-refresh` roster ingestion function.
2. If you need to test locally, start them with `npm run functions:serve` and
   trigger requests from the planner UI or your own scripts.
3. Verify the deployment by hitting the `/health` function—when it returns `ok`
   the database and OpenAI credentials are correctly wired.

## 5. Prepare automation inputs

- [ ] Upload any supporting documents through the docs console so the retrieval
      pipeline has content to embed.
- [ ] Review the sector prompts and question registry to make sure the heuristics
      align with your investment process.
- [ ] Create a run from the planner, select Stage 1–3 models, budget, scope
      (universe, watchlist, or custom), and cadence, then click **Start automated
      run**.

## 6. Enable unattended execution

1. Toggle **Auto continue** within the planner to watch a run progress end to
   end.
2. Configure background schedules from the planner (or directly against the
   `run_schedules` table) so Supabase cron can advance batches every hour.
3. Monitor spend and task throughput from the planner dashboard; adjust
   `RUNS_DAILY_LIMIT` or budgets as required.

Once these steps are complete the system is production-ready for automated
hourly coverage. Future enhancements (notifications, focus questions, cached
context) can be layered on without disturbing the core pipeline above.
