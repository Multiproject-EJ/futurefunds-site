# FutureFunds.ai site

This repository hosts the static marketing and member experience for FutureFunds.ai. The
pages under `/assets` provide the interactive logic for authentication, the research
universe, and internal tooling.

## Developer docs

- [Supabase database reference](docs/supabase-schema.md) — canonical contract for the
  tables, policies, and triggers the frontend expects.
- [Automated equity analyst roadmap](docs/equity-analyst-roadmap.md) — phased build plan for the
  multi-stage research system and associated UI.
- [Sector prompt library](sectors.html) — admin console to curate Stage 2 heuristics synced to the planner.
- [Universe cockpit](universe.html) — requires the helper functions from `sql/003_dashboard_helpers.sql`
  and `sql/005_universe_snapshot.sql` to surface run outputs and ticker dossiers.
- Database migrations live under `/sql` (apply them with `supabase db push` or your preferred
  migration runner).
