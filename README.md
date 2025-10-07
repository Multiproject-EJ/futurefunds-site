# FutureFunds.ai site

This repository hosts the static marketing and member experience for FutureFunds.ai. The
pages under `/assets` provide the interactive logic for authentication, the research
universe, and internal tooling.

## Getting started

1. Copy `.env.example` to `.env` and supply your Supabase URL, anon key,
   service role key, model credentials, and notification settings
   (`ALERTS_PUBLIC_BASE_URL`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`). Mirror
   these values inside the Supabase dashboard (`Project Settings →
   Configuration → Secrets`) so deployed edge functions can read them.
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
6. Deploy the `runs-focus` and `focus-consume` edge functions if you want to queue
   post–Stage 3 focus questions from the planner. Admins can mix reusable templates
   with ad-hoc prompts per ticker, and automation will record answers with citations
   alongside the Stage 4 ledger entries.
7. Feed deterministic metrics into the new scoring ensemble tables. Seed rows for
   `scoring_factors`, schedule ingestion into `ticker_factor_snapshots`, and the
   planner/ticker dashboards will display blended LLM + factor scores with per-factor
   breakdowns.
8. Configure Stage 3 alerts from the planner’s **Alerts & notifications** panel
   once migrations are applied. Add email or Slack channels, set conviction
   thresholds, and verify alerts arrive when finalists are promoted.

## Project status

- The full [automation roadmap](docs/equity-analyst-roadmap.md) is now checked off,
  including the stretch features for cached completions, scoring ensembles, focus
  questions, and automated notifications.
- All migrations through `sql/017_notifications.sql`, Supabase Edge functions, and
  planner dashboards ship in this repository; running through the
  [first run checklist](docs/first-run-checklist.md) will prepare an environment for
  end-to-end validation.
- After completing the checklist, schedule an hourly run from the planner or
  dispatcher to begin acceptance testing of the unattended equity-analysis loop.

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
- [Planner launch smoke test](docs/planner-launch-troubleshooting.md) — step-by-step
  checklist to validate run creation and surface detailed error diagnostics when
  Supabase rejects a launch.
- [Sector prompt library](sectors.html) — admin console to curate Stage 2 heuristics synced to the planner.
- [Universe cockpit](universe.html) — requires the helper functions from `sql/003_dashboard_helpers.sql`
  and `sql/005_universe_snapshot.sql` to surface run outputs and ticker dossiers.
- Question + scoring registry lives in `sql/007_question_registry.sql`; apply it after the
  core schema so Stage&nbsp;3 workers can resolve dimensions, dependency graphs, and
  weighted scorecards.
- Database migrations live under `/sql` (apply them with `supabase db push` or your preferred
  migration runner).

## Working with GitHub pull requests

When you open **View pull request** in GitHub and see the banner `Pull request successfully
merged and closed`, that means the work from that branch already lives on the main branch.
To keep iterating, follow these steps:

1. Sync your local repository so it has the latest main branch:
   ```bash
   git checkout main
   git pull origin main
   ```
2. Create a new feature branch for the next round of changes:
   ```bash
   git checkout -b feature/your-change-name
   ```
3. Make and stage your edits (for example, restoring a modal or adjusting copy):
   ```bash
   # edit files
   git status            # confirm the modified files
   git add <files>
   ```
4. Commit and push the new branch:
   ```bash
   git commit -m "Describe the fix or feature"
   git push origin feature/your-change-name
   ```
5. Open a fresh pull request from the pushed branch. GitHub will show the diff against the
   latest main branch, and reviewers can merge it once the changes look good.

If you need to revisit the earlier implementation that was merged, use the **Commits** tab in
GitHub (or `git log`) to find the specific commit hash. You can then check it out locally with
`git checkout <hash>` to inspect the previous state before porting pieces into your new branch.
