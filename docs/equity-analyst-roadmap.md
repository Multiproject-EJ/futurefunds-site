# Automated Equity Analyst Development Roadmap

This roadmap translates the analyst automation conversation into an actionable, PR-by-PR delivery
plan. Treat each phase as a small, reviewable milestone so the Codex workflow can ship improvements
incrementally.

## 0. Foundations (Week 0)
- [ ] **Repository scaffolding** – confirm `/web`, `/api`, `/sql`, `/docs` folders exist and add
      `.env.example` with `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `OPENAI_API_KEY`.
- [ ] **Dependencies** – ensure Supabase and OpenAI SDKs installed where server code will run.
- [ ] **Design brief** – circulate this roadmap + equity_analyst.html overview with stakeholders.

## 1. Data Contract & Seed (Week 1)
- [ ] `sql/001_core.sql` – create `tickers`, `runs`, `run_items`, `answers`, `cost_ledger`,
      `sector_prompts`, and `doc_chunks` tables.
- [ ] `sql/002_seed.sql` – seed 10 flagship tickers across sectors.
- [ ] Add Supabase migration scripts / npm tasks to run migrations locally and in staging.

## 2. Planner Experience (Week 1–2)
- [ ] Build `web/admin/planner.html` with live cost estimator (universe slider, survival sliders,
      per-stage token inputs, model selectors, total cost output).
- [ ] Persist planner state to `localStorage` and surface a **Start Run** CTA.
- [ ] Implement `/api/runs/create` endpoint to insert a run row and queue `run_items`.

## 3. Stage 1 – Cheap Triage (Week 2)
- [ ] `/api/stage1/consume` worker: pull pending items, call GPT-4o-mini, store JSON label + usage
      in `answers` and `cost_ledger`, update `run_items`.
- [ ] Planner UI: add **Process Stage 1 batch** control and progress stats (processed / total /
      remaining).
- [ ] Add retry/backoff (429, 5xx) and structured error logging for failed items.

## 4. Stage 2 – Thematic Scoring (Week 3)
- [ ] Survivor filter: only `label` in (`consider`, `borderline`).
- [ ] `/api/stage2/consume`: gather sector notes, Stage 1 output, retrieved snippets; call GPT-5-mini
      with JSON schema covering profitability, reinvestment, leverage, moat, timing.
- [ ] Persist `go_deep` boolean to `run_items` and show Stage 2 progress in planner.

## 5. Sector Intelligence CMS (Week 3)
- [ ] `web/admin/sectors.html`: CRUD editor for `sector_prompts` with autosave + version tag.
- [ ] Surface sector notes summary inside planner to remind analysts what heuristics are in play.

## 6. Stage 3 – Deep Dive Reports (Week 4)
- [ ] `/api/stage3/consume`: for tickers with `go_deep=true`, orchestrate 4–6 grouped prompts using
      GPT-5, injecting retrieved RAG facts (from `doc_chunks`).
- [ ] Store each grouped response in `answers`; synthesise a long-form narrative into
      `answer_text`.
- [ ] Planner UI: **Process Stage 3 batch** and highlight total deep-dive spend.

## 7. Universe & Report Views (Week 4–5)
- [ ] `web/universe.html`: searchable table summarising ticker, stage, label, scores, spend.
- [ ] `web/ticker/{ticker}.html`: render Stage 1–3 outputs, sector notes, and allow CSV / JSON
      export.
- [ ] Add shareable permalink for members (respect Supabase Auth).

## 8. Cost Governance (Week 5)
- [ ] Store `runs.budget_usd` and show in planner alongside actual cost-to-date.
- [ ] Auto-stop runs when spend >= budget or when `stop_requested` is true.
- [ ] Add sparkline / bar chart for stage-level spend (client-side or lightweight chart lib).

## 9. Automation Loop (Week 6)
- [ ] `/api/runs/continue` endpoint to sequentially trigger Stage 1 → 3 until batch limit / stop.
- [ ] Planner toggle for **Auto continue** that polls the endpoint every N seconds.
- [ ] Optional: schedule nightly cron (Supabase Edge) to run small watchlists.

## 10. Retrieval Augmentation (Week 6–7)
- [ ] `docs` uploader UI to add filings, transcripts, letters; chunk + embed into `doc_chunks`.
- [ ] Retrieval helper RPC (e.g., `match_doc_chunks`) returning top-k snippets per query.
- [ ] Integrate retrieved snippets into Stage 2 & 3 prompts with citation metadata.

## 11. Member Experience & Auth (Week 7)
- [ ] Gate analyst pages behind Supabase Auth; provide onboarding flow for new members.
- [ ] Track per-user quotas (e.g., runs per day) using Supabase policies or server logic.
- [ ] Post-run feedback widget so members can trigger manual follow-up questions (optional).

## 12. Observability & Safety (Week 8)
- [ ] `/api/health` endpoint (DB + OpenAI status) for uptime monitors.
- [ ] `error_logs` table + viewer UI capturing payloads, prompt ids, retry counts.
- [ ] Automated regression tests for prompt output schemas and JSON validators.

## 13. Prompt & Model Registry (Week 8–9)
- [ ] Store prompt templates as markdown files with interpolation tokens.
- [ ] Central config (e.g., `config/models.json`) containing price per model, default temperature,
      cache policy, retry settings.
- [ ] Loader utility to compose prompts per sector & stage and to map usage -> cost ledger.

## 14. Stretch Enhancements (Backlog)
- [ ] Cached context via OpenAI Responses API to reuse deterministic summaries.
- [ ] Advanced scoring ensembles (blend LLM output with deterministic factors).
- [ ] User-triggered “Focus questions” appended post Stage 3.
- [ ] Automated notification system (email / Slack) when high-conviction names found.

---

### Working style notes
- Ship in small PRs; keep each milestone isolated (DB, API, UI) to simplify QA.
- Document prompts and schema updates in `/docs/changelog.md` for future analysts.
- Reference `equity_analyst.html` during design reviews to keep UI & DX aligned.
