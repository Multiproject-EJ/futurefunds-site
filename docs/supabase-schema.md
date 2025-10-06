# Supabase database reference

This document captures the contract between the FutureFunds frontend and the Supabase
Postgres project. Keep the tables, policies, and triggers described below in sync whenever
schema changes are made so the static site and backend continue to agree on shapes and
access rules.

## Overview

The site ships a core set of application tables in the `public` schema:

| Table | Purpose |
| --- | --- |
| `profiles` | Stores metadata about each authenticated user (role, email, timestamps). |
| `memberships` | Mirrors membership billing state so the site can gate premium content. |
| `universe` | Holds the research briefs that power `/universe.html` and the editor workflow. |
| `editor_prompts` | Configurable AI prompt templates surfaced in the research editor. |
| `editor_models` | Configurable AI model catalogue used by the editor UI. |
| `editor_api_credentials` | Stores AI provider secrets the editor can retrieve at runtime. |
| `stock_analysis_todo` | Tracks stock analysis coverage (company, status, type, and analysis date). |

The automated equity analyst pipeline introduces an additional suite of tables that power
multi-stage model runs and reporting:

| Table | Purpose |
| --- | --- |
| `tickers` | Canonical universe of symbols the automation can draw from, one row per ticker. |
| `watchlists` | Named collections of tickers that the planner can target. |
| `watchlist_entries` | Join table linking watchlists to tickers with optional ordering. |
| `ticker_events` | Audit log of roster changes emitted by ingestion jobs. |
| `sector_prompts` | Optional sector-specific prompt augmentations injected into Stage 2+. |
| `runs` | High-level batch execution log for each analysis sweep (start time, status, budget flags). |
| `run_items` | Per-ticker processing state tracking the current stage, label, and spend. |
| `run_schedules` | Stores per-run automation cadence, batch limits, and activation state for the background dispatcher. |
| `run_feedback` | Captures post-run follow-up questions submitted by members or automation for analyst review. |
| `focus_question_templates` | Library of reusable focus prompts Stage 3 automation can append after deep dives. |
| `focus_question_requests` | Queue of ticker-specific focus prompts awaiting automated responses and citations. |
| `answers` | Stores structured and narrative outputs produced at each stage of the pipeline. |
| `cost_ledger` | Aggregated token usage and USD cost per stage/run for budget monitoring. |
| `cached_completions` | Persistent cache of deterministic model outputs reused across runs to avoid duplicate spend. |
| `doc_chunks` | Optional retrieval corpus of text snippets (10-Ks, transcripts, etc.) used for RAG. |
| `analysis_dimensions` | Registry of scoring dimensions (financial resilience, leadership, etc.) with color/weight metadata. |
| `analysis_questions` | Question bank powering Stage&nbsp;3 prompts, dependency graphing, and verdict schemas. |
| `analysis_question_results` | Per-question outputs (verdict, score, tags) stored per run/ticker for browser caching. |
| `analysis_dimension_scores` | Aggregated dimension verdicts and weights derived from question results for dashboards. |
| `scoring_factors` | Deterministic factor catalogue (growth, leverage, valuation metrics) referenced by ensembles. |
| `dimension_factor_links` | Mapping table tying analysis dimensions to deterministic factors with weights. |
| `ticker_factor_snapshots` | Per-ticker factor values/score snapshots populated by ingestion jobs and feeds. |

The analyst dashboard queries a handful of helper functions to avoid shipping large
payloads to the browser:

## Prompt templates & model registry

- Markdown prompt templates now live under `/prompts`, grouped by stage. Each template supports
  mustache-style interpolation tokens (e.g., `{{ticker}}`, `{{stage1_block}}`) rendered at runtime by
  `supabase/functions/_shared/prompt-loader.ts`.
- Static model metadata and stage-level request policies live in `config/models.json`. Edge functions
  call `shared/model-config.js` to resolve default and fallback models, preferred cache settings, and
  retry policies when Supabase lookups are unavailable.

| Function | Purpose |
| --- | --- |
| `run_stage_status_counts(run_id uuid)` | Aggregates `run_items` into stage/status buckets for progress bars and totals. |
| `run_stage1_labels(run_id uuid)` | Returns the Stage&nbsp;1 label distribution for survivors (e.g., uninvestible / consider). |
| `run_stage2_summary(run_id uuid)` | Summarises Stage&nbsp;2 survivors, pending queue, completions, failures, and go-deep approvals. |
| `run_stage3_summary(run_id uuid)` | Aggregates Stage&nbsp;3 finalists, pending deep dives, completed reports, and failures. |
| `run_cost_breakdown(run_id uuid)` | Summarises `cost_ledger` spend by stage/model for budget monitoring. |
| `run_cost_summary(run_id uuid)` | Provides overall spend and token totals for a run. |
| `run_focus_summary(run_id uuid)` | Aggregates queued, completed, and failed focus-question requests per run. |
| `run_latest_activity(run_id uuid, limit int)` | Streams the latest answers (stage, ticker, summary) for the activity feed. |
| `run_feedback_for_run(run_id uuid)` | Returns the manual follow-up queue for a given run ordered by submission time. |
| `run_universe_rows(run_id uuid, ...)` | Paginates ticker-level snapshots (stage, label, spend, Stage 1–3 JSON) for the universe dashboard. |
| `run_universe_facets(run_id uuid, ...)` | Returns stage/label/sector counts that power the filter badges in `/universe.html`. |
| `run_ticker_details(run_id uuid, ticker text)` | Fetches the full dossier (Stage 1–3 outputs) for the ticker drilldown page. |

Apply `sql/003_dashboard_helpers.sql` and `sql/005_universe_snapshot.sql` to provision or update these functions.

The tables rely on three helper routines:

- `handle_new_user()` – creates a profile row whenever Supabase Auth provisions a user.
- `set_updated_at()` – keeps `updated_at` columns current on updates.
- `is_paid_member(uid uuid)` – implements the membership check that row-level policies rely on.

## Table details

### `profiles`

*Primary key*: `id uuid` referencing `auth.users(id)`.

| Column | Type | Default | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | — | Must match the Supabase Auth user id. Frontend upserts `{ id, email }` whenever a session is established.【F:assets/supabase.js†L20-L25】 |
| `email` | `text` | `null` | Cached copy of the user email for convenience.【F:assets/supabase.js†L20-L25】 |
| `role` | `text` | `'member'` | Assign `admin` (any casing) to unlock internal tooling like the research editor. The editor enforces `requireRole('admin')`, which recognises `admin`, `administrator`, or `superadmin` markers in the profile before writing universe rows.【F:assets/auth.js†L441-L495】【F:assets/editor.js†L720-L773】 |
| `created_at` | `timestamptz` | `now()` | Managed automatically by Postgres. |
| `updated_at` | `timestamptz` | `now()` | Updated through the `set_updated_at` trigger (see below). |

**Policies**

- `SELECT`: `auth.role() = 'authenticated'` so signed-in users can read their profile.
- `INSERT` / `UPDATE`: `auth.uid() = id` (users can maintain their own record).
- Administrative updates can use the service role key.

**Triggers**

- `handle_new_user` on `auth.users` → `profiles` (AFTER INSERT) creates `{ id, email }` rows automatically to match the frontend’s `ensureProfile` helper.【F:assets/supabase.js†L20-L41】
- `set_updated_at` (BEFORE UPDATE) keeps `updated_at` in sync.

### `memberships`

*Primary key*: `user_id uuid` referencing `auth.users(id)`.

| Column | Type | Default | Notes |
| --- | --- | --- | --- |
| `user_id` | `uuid` | — | Foreign key back to `profiles.id`. The client fetches rows by `user_id` equality.【F:assets/supabase.js†L44-L57】 |
| `status` | `text` | `'inactive'` | The UI treats anything other than `active` as locked content.【F:assets/supabase.js†L59-L67】 |
| `current_period_end` | `timestamptz` | `null` | Optional expiry the UI compares against `Date.now()` to expire access.【F:assets/supabase.js†L59-L67】 |
| `tier` | `text` | `null` | Optional descriptive tier (Starter, Pro, etc.). |
| `source` | `text` | `'membership'` | Indicates the billing platform (Stripe, Lemon Squeezy, manual, etc.). |
| `created_at` | `timestamptz` | `now()` | Managed automatically. |
| `updated_at` | `timestamptz` | `now()` | Managed by `set_updated_at` trigger. |

**Policies**

- `SELECT`: `auth.uid() = user_id` so members see their own status in the account modal.【F:assets/auth.js†L218-L298】
- `INSERT` / `UPDATE`: restricted to service-role integrations that sync membership billing data.
- Helper function `is_paid_member(auth.uid())` is used by content tables (e.g., `universe`) to gate read access; keep its logic aligned with `isMembershipActive` in the frontend.【F:assets/supabase.js†L59-L67】

### `universe`

*Primary key*: `id bigint generated always as identity`.

| Column | Type | Default | Notes |
| --- | --- | --- | --- |
| `date` | `date` | `current_date` | Displayed as the headline date throughout the UI.【F:assets/universe.js†L47-L158】【F:assets/editor.js†L734-L772】 |
| `topic` | `text` | — | Required title for a brief.【F:assets/editor.js†L734-L772】 |
| `prompt_used` | `text` | `''` | Stores which AI template generated the brief.【F:assets/editor.js†L734-L772】 |
| `key_findings` | `text[]` | `{}` | Rendered as bullet points in the table view.【F:assets/universe.js†L65-L158】 |
| `visual_table_md` | `text` | `''` | Markdown table snippet that gets rendered inline.【F:assets/universe.js†L65-L158】 |
| `conclusion` | `text` | — | Required summary paragraph.【F:assets/editor.js†L734-L772】 |
| `analysis_markdown` | `text` | `''` | Full markdown saved from the editor (older rows may use `analysis_full`/`analysis_full_md`, which the UI still reads).【F:assets/universe.js†L65-L158】 |
| `tags` | `text[]` | `{}` | Used for filtering and chips.【F:assets/universe.js†L80-L106】【F:assets/editor.js†L734-L772】 |
| `company` | `text` | `null` | Optional company name displayed by the new UI cards. |
| `current_price` | `numeric` | `null` | Latest price as a numeric value for sorting/filtering. |
| `current_price_raw` | `text` | `null` | Unformatted price payload saved from upstream feeds. |
| `current_price_display` | `text` | `null` | Human-ready price string rendered in the UI. |
| `currency` | `text` | `null` | ISO currency code tied to the price fields. |
| `risk_rating` | `text` | `null` | Optional qualitative rating label shown in UI badges. |
| `financials_markdown` | `text` | `null` | Extended financials section rendered below the main analysis. |
| `strategies` | `jsonb` | `'{}'::jsonb` | Structured strategy metadata consumed by the new interface. |
| `metrics` | `jsonb` | `'{}'::jsonb` | Structured metrics payload consumed by the new interface. |
| `placeholder1` | `jsonb` | `'{}'::jsonb` | Reserved for future structured content. |
| `placeholder2` | `jsonb` | `'{}'::jsonb` | Reserved for future structured content. |
| `created_at` | `timestamptz` | `now()` | Automatically managed. |
| `updated_at` | `timestamptz` | `now()` | Managed by `set_updated_at`. |
| `created_by` | `uuid` | `auth.uid()` | Optional audit column to track editors. |

**Policies**

- `SELECT`: `is_paid_member(auth.uid())` allows members to read the archive. Consider a second policy that returns a limited preview for anonymous sessions (matching the frontend’s preview behaviour).【F:assets/universe.js†L139-L205】
- `INSERT` / `UPDATE`: `auth.uid()` with `profiles.role = 'admin'` so only staff can publish new rows (the editor enforces this on the client).【F:assets/editor.js†L720-L773】

Run the following migration to provision the new UI fields and backfill empty JSON objects for existing rows:

```sql
alter table public.universe
  add column if not exists company text,
  add column if not exists current_price numeric,
  add column if not exists current_price_raw text,
  add column if not exists current_price_display text,
  add column if not exists currency text,
  add column if not exists risk_rating text,
  add column if not exists financials_markdown text,
  add column if not exists strategies jsonb default '{}'::jsonb,
  add column if not exists metrics jsonb default '{}'::jsonb,
  add column if not exists placeholder1 jsonb default '{}'::jsonb,
  add column if not exists placeholder2 jsonb default '{}'::jsonb;

update public.universe
   set strategies   = coalesce(strategies, '{}'::jsonb),
       metrics      = coalesce(metrics, '{}'::jsonb),
       placeholder1 = coalesce(placeholder1, '{}'::jsonb),
       placeholder2 = coalesce(placeholder2, '{}'::jsonb);
```

### `editor_prompts`

*Primary key*: `id uuid` (or text slug).

| Column | Type | Default | Notes |
| --- | --- | --- | --- |
| `id` | `uuid`/`text` | generated | Stable identifier used to persist the user’s default prompt selection.【F:assets/editor.js†L265-L333】 |
| `slug` | `text` | generated from `name` | Optional alternative key – the UI falls back to it when `id` is missing.【F:assets/editor.js†L279-L289】 |
| `name` | `text` | — | Human-readable label.【F:assets/editor.js†L279-L289】 |
| `description` | `text` | `''` | Tooltip/summary string.【F:assets/editor.js†L285-L293】 |
| `prompt_text` | `text` | — | Primary template body consumed by AI generation.【F:assets/editor.js†L279-L293】 |
| `sort_order` | `int` | `1000` | Determines display order; defaults to a high value when null so manual ordering works.【F:assets/editor.js†L294-L300】 |
| `is_default` | `boolean` | `false` | Marks which template should auto-select first.【F:assets/editor.js†L315-L324】 |
| `archived` | `boolean` | `false` | Hidden from menus when true.【F:assets/editor.js†L294-L300】 |
| `created_at` | `timestamptz` | `now()` | Managed automatically. |
| `updated_at` | `timestamptz` | `now()` | Managed by `set_updated_at`. |

**Policies**

- `SELECT`: `profiles.role = 'admin'` so only staff editors can fetch prompt templates (front-end requires admin before hitting Supabase).【F:assets/editor.js†L720-L773】
- `INSERT` / `UPDATE`: admin-only.

### `editor_models`

*Primary key*: `value text` (model identifier).

| Column | Type | Default | Notes |
| --- | --- | --- | --- |
| `value` | `text` | — | Unique identifier persisted with user preferences and used as the upsert conflict target.【F:assets/editor.js†L336-L367】【F:assets/editor.js†L443-L465】 |
| `label` | `text` | `value` | Display label in the dropdown.【F:assets/editor.js†L336-L367】 |
| `sort_order` | `int` | `1000` | Controls dropdown ordering; defaults high when null so manual ordering works.【F:assets/editor.js†L355-L360】 |
| `is_default` | `boolean` | `false` | Marks the default model (first in list).【F:assets/editor.js†L315-L324】【F:assets/editor.js†L443-L465】 |
| `archived` | `boolean` | `false` | Archived models are filtered out; the sync routine toggles this flag when options change.【F:assets/editor.js†L343-L355】【F:assets/editor.js†L443-L465】 |
| `created_at` | `timestamptz` | `now()` | Managed automatically. |
| `updated_at` | `timestamptz` | `now()` | Managed by `set_updated_at`. |

**Policies**

- `SELECT`: admin-only to match the editor gating.
- `INSERT` / `UPDATE`: admin-only (performed through the editor model management UI).【F:assets/editor.js†L430-L503】

#### Catalogue snapshot (25 September 2025)

The research editor currently surfaces the following free model presets. Keep the
`editor_models` table in Supabase aligned with this catalogue when onboarding new
providers or adjusting defaults.

| Label | Value |
| --- | --- |
| xAI: Grok 4 Fast (free) | `x-ai/grok-4-fast:free` |
| NVIDIA: Nemotron Nano 9B V2 (free) | `nvidia/nemotron-nano-9b-v2:free` |
| DeepSeek: DeepSeek V3.1 (free) | `deepseek/deepseek-chat-v3.1:free` |
| OpenAI: gpt-oss-120b (free) | `openai/gpt-oss-120b:free` |
| OpenAI: gpt-oss-20b (free) | `openai/gpt-oss-20b:free` |
| Z.AI: GLM 4.5 Air (free) | `z-ai/glm-4.5-air:free` |
| Qwen: Qwen3 Coder 480B A35B (free) | `qwen/qwen3-coder:free` |
| MoonshotAI: Kimi K2 0711 (free) | `moonshotai/kimi-k2:free` |
| Venice: Uncensored (free) | `cognitivecomputations/dolphin-mistral-24b-venice-edition:free` |
| Google: Gemma 3n 2B (free) | `google/gemma-3n-e2b-it:free` |
| Tencent: Hunyuan A13B Instruct (free) | `tencent/hunyuan-a13b-instruct:free` |
| TNG: DeepSeek R1T2 Chimera (free) | `tngtech/deepseek-r1t2-chimera:free` |
| Mistral: Mistral Small 3.2 24B (free) | `mistralai/mistral-small-3.2-24b-instruct:free` |
| MoonshotAI: Kimi Dev 72B (free) | `moonshotai/kimi-dev-72b:free` |
| DeepSeek: Deepseek R1 0528 Qwen3 8B (free) | `deepseek/deepseek-r1-0528-qwen3-8b:free` |
| DeepSeek: R1 0528 (free) | `deepseek/deepseek-r1-0528:free` |
| Mistral: Devstral Small 2505 (free) | `mistralai/devstral-small-2505:free` |
| Google: Gemma 3n 4B (free) | `google/gemma-3n-e4b-it:free` |
| Meta: Llama 3.3 8B Instruct (free) | `meta-llama/llama-3.3-8b-instruct:free` |
| Qwen: Qwen3 4B (free) | `qwen/qwen3-4b:free` |
| Qwen: Qwen3 30B A3B (free) | `qwen/qwen3-30b-a3b:free` |
| Qwen: Qwen3 8B (free) | `qwen/qwen3-8b:free` |
| Qwen: Qwen3 14B (free) | `qwen/qwen3-14b:free` |
| Qwen: Qwen3 235B A22B (free) | `qwen/qwen3-235b-a22b:free` |
| TNG: DeepSeek R1T Chimera (free) | `tngtech/deepseek-r1t-chimera:free` |
| Microsoft: MAI DS R1 (free) | `microsoft/mai-ds-r1:free` |
| Shisa AI: Shisa V2 Llama 3.3 70B (free) | `shisa-ai/shisa-v2-llama3.3-70b:free` |
| ArliAI: QwQ 32B RpR v1 (free) | `arliai/qwq-32b-arliai-rpr-v1:free` |
| Agentica: Deepcoder 14B Preview (free) | `agentica-org/deepcoder-14b-preview:free` |
| MoonshotAI: Kimi VL A3B Thinking (free) | `moonshotai/kimi-vl-a3b-thinking:free` |
| Meta: Llama 4 Maverick (free) | `meta-llama/llama-4-maverick:free` |
| Meta: Llama 4 Scout (free) | `meta-llama/llama-4-scout:free` |
| Qwen: Qwen2.5 VL 32B Instruct (free) | `qwen/qwen2.5-vl-32b-instruct:free` |
| DeepSeek: DeepSeek V3 0324 (free) | `deepseek/deepseek-chat-v3-0324:free` |
| Mistral: Mistral Small 3.1 24B (free) | `mistralai/mistral-small-3.1-24b-instruct:free` |
| Google: Gemma 3 4B (free) | `google/gemma-3-4b-it:free` |
| Google: Gemma 3 12B (free) | `google/gemma-3-12b-it:free` |
| Google: Gemma 3 27B (free) | `google/gemma-3-27b-it:free` |
| Nous: DeepHermes 3 Llama 3 8B Preview (free) | `nousresearch/deephermes-3-llama-3-8b-preview:free` |
| Dolphin3.0 R1 Mistral 24B (free) | `cognitivecomputations/dolphin3.0-r1-mistral-24b:free` |
| Dolphin3.0 Mistral 24B (free) | `cognitivecomputations/dolphin3.0-mistral-24b:free` |
| Qwen: Qwen2.5 VL 72B Instruct (free) | `qwen/qwen2.5-vl-72b-instruct:free` |
| Mistral: Mistral Small 3 (free) | `mistralai/mistral-small-24b-instruct-2501:free` |
| DeepSeek: R1 Distill Llama 70B (free) | `deepseek/deepseek-r1-distill-llama-70b:free` |
| DeepSeek: R1 (free) | `deepseek/deepseek-r1:free` |
| Google: Gemini 2.0 Flash Experimental (free) | `google/gemini-2.0-flash-exp:free` |
| Meta: Llama 3.3 70B Instruct (free) | `meta-llama/llama-3.3-70b-instruct:free` |
| Qwen2.5 Coder 32B Instruct (free) | `qwen/qwen-2.5-coder-32b-instruct:free` |
| Meta: Llama 3.2 3B Instruct (free) | `meta-llama/llama-3.2-3b-instruct:free` |
| Qwen2.5 72B Instruct (free) | `qwen/qwen-2.5-72b-instruct:free` |
| Mistral: Mistral Nemo (free) | `mistralai/mistral-nemo:free` |
| Google: Gemma 2 9B (free) | `google/gemma-2-9b-it:free` |
| Mistral: Mistral 7B Instruct (free) | `mistralai/mistral-7b-instruct:free` |

### `editor_api_credentials`

*Primary key*: `id uuid` generated via `gen_random_uuid()`.

| Column | Type | Default | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | `gen_random_uuid()` | Primary key used for auditing and trigger updates. |
| `provider` | `text` | — | Identifier for the AI service (e.g., `openrouter`). |
| `label` | `text` | — | Human-readable description shown in internal tooling. |
| `api_key` | `text` | — | The raw credential used when invoking the external API from the editor. |
| `is_active` | `boolean` | `true` | Allows rotating secrets without deleting history. |
| `created_at` | `timestamptz` | `now()` | Automatically managed. |
| `updated_at` | `timestamptz` | `now()` | Maintained by the shared `set_updated_at` trigger. |

**Policies**

- `SELECT`: restricted to admins by verifying `profiles.role = 'admin'` for the current user.
- `INSERT` / `UPDATE` / `DELETE`: admin-only so only trusted staff can rotate credentials.

**Triggers**

- `set_updated_at` (BEFORE UPDATE) keeps `updated_at` in sync for auditing.

**Seed data**

- The initial migration inserts an OpenRouter key (`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`). Run the seed with a service-role key so the secret never passes through the anon client.

### `stock_analysis_todo`

*Primary key*: `id bigint generated always as identity`.

| Column | Type | Default | Notes |
| --- | --- | --- | --- |
| `company_name` | `text` | — | Name of the company being tracked. |
| `has_been_analyzed` | `boolean` | `false` | Indicates whether coverage is complete. |
| `analysis_type` | `text` | — | Constrained to `initial screen`, `deep research`, or `company specific`. |
| `analysis_date` | `date` | `current_date` | Defaults to the day the row was inserted. |
| `created_at` | `timestamptz` | `now()` | Managed automatically. |
| `updated_at` | `timestamptz` | `now()` | Managed by `set_updated_at`. |

**Policies**

- `SELECT`: `auth.role() = 'authenticated'` so any signed-in user can read the tracking list.
- `INSERT` / `UPDATE` / `DELETE`: restricted to admins by checking `profiles.role = 'admin'` for the current user.

## Helper routines

### `handle_new_user()`

```sql
create function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();
```

- Mirrors the frontend’s `ensureProfile` helper by inserting the `{ id, email }` pair when a user first signs in. The UPSERT keeps cached emails in sync.【F:assets/supabase.js†L20-L41】

### `set_updated_at()`

```sql
create function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = timezone('utc', now());
  return new;
end;
$$;
```

Attach this `BEFORE UPDATE` trigger to tables with an `updated_at` column (`profiles`, `memberships`, `universe`, `editor_prompts`, `editor_models`, `stock_analysis_todo`).

### `is_paid_member(uid uuid)`

```sql
create function public.is_paid_member(uid uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
    from public.memberships m
    where m.user_id = uid
      and lower(coalesce(m.status, '')) = 'active'
      and (m.current_period_end is null or m.current_period_end > timezone('utc', now()))
  );
$$;
```

- Row-level security on `universe` and other premium content should call this helper so the backend matches the frontend’s `isMembershipActive` logic.【F:assets/supabase.js†L59-L67】【F:assets/universe.js†L139-L205】

## Change management checklist

When altering the schema or policies:

1. Update this reference file alongside any SQL migrations.
2. Ensure the frontend code still aligns with column names, types, and access rules described above.
3. Re-run the membership gating scenarios in `/assets/universe.js` and `/assets/editor.js` after deploying database updates.

## Automated equity analyst tables

Keep the following schemas in sync with `/sql/001_core.sql` when running migrations.

### `tickers`

*Primary key*: `ticker text`.

| Column | Type | Default | Notes |
| --- | --- | --- | --- |
| `ticker` | `text` | — | Upper-case trading symbol (e.g., `AAPL`). |
| `name` | `text` | `null` | Company name used in prompts and UI. |
| `exchange` | `text` | `null` | Listing exchange (NASDAQ, LSE, HKEX, etc.). |
| `country` | `text` | `null` | Country code or descriptor. |
| `sector` | `text` | `null` | High-level sector grouping. |
| `industry` | `text` | `null` | Optional finer industry classification. |
| `status` | `text` | `'active'` | Lifecycle marker used by the automation (`active`, `inactive`, `delisted`, `pending`, `unknown`). |
| `listed_at` | `date` | `null` | Optional IPO/listing date used for bookkeeping. |
| `delisted_at` | `date` | `null` | Populated when the roster maintenance job infers a delisting. |
| `aliases` | `text[]` | `'{}'` | Prior names/tickers captured when maintenance detects a rename. |
| `last_seen_at` | `timestamptz` | `now()` | Updated by ingestion jobs to note the latest roster refresh. |
| `source` | `text` | `null` | Origin of the last update (`planner:watchlist`, `tickers-refresh`, etc.). |
| `metadata` | `jsonb` | `'{}'::jsonb` | Arbitrary structured fields (FIGI, ISIN, listing MIC, etc.). |
| `created_at` | `timestamptz` | `now()` | Auto timestamp. |
| `updated_at` | `timestamptz` | `now()` | Managed by trigger `touch_updated_at` so manual edits stay fresh. |

Seed `/sql/002_seed.sql` for local smoke tests, then run `/sql/013_watchlists.sql` to enable roster maintenance triggers, `ticker_events`, and watchlist policies.

Row-level security allows anonymous reads but restricts inserts/updates/deletes to admins (enforced by the `is_admin(uid)` helper). The `tickers-refresh` worker (`supabase/functions/tickers-refresh`) upserts records in bulk, records `ticker_events`, and marks missing exchange constituents as `delisted` when `mark_missing=true`.

### `watchlists`

*Primary key*: `id uuid` (`gen_random_uuid()`).

| Column | Type | Default | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | `gen_random_uuid()` | Identifier referenced by planner scope settings and runs. |
| `name` | `text` | — | Human-readable name surfaced in the planner. |
| `slug` | `text` | — | Unique slug used for API lookups. |
| `description` | `text` | `null` | Optional summary shown in the planner. |
| `is_system` | `boolean` | `false` | Marks built-in/shared watchlists. |
| `is_public` | `boolean` | `false` | Exposes the watchlist to all authenticated users (read-only). |
| `created_by` | `uuid` | `null` | Admin who created the list. |
| `created_by_email` | `text` | `null` | Snapshot of the creator’s email for audit trails. |
| `created_at` | `timestamptz` | `now()` | Auto timestamp. |
| `updated_at` | `timestamptz` | `now()` | Managed by `touch_updated_at`. |

Admins (per `is_admin(uid)`) can insert/update/delete; members can read public watchlists. The planner UI (`planner.html`) surfaces CRUD controls for admins, while non-admins fall back to the full-universe mode.

### `watchlist_entries`

Composite primary key: `(watchlist_id, ticker)`.

| Column | Type | Default | Notes |
| --- | --- | --- | --- |
| `watchlist_id` | `uuid` | — | References `watchlists(id)` with cascade delete. |
| `ticker` | `text` | — | References `tickers(ticker)`; planner will upsert tickers before insertion. |
| `rank` | `int` | `null` | Optional ordering hint used for display. |
| `notes` | `text` | `null` | Stage guidance or reminders captured alongside the ticker. |
| `added_at` | `timestamptz` | `now()` | Automatically populated on insert. |
| `removed_at` | `timestamptz` | `null` | Soft-delete marker so history can be audited. |

Non-admins can read entries belonging to public watchlists they can see; admins or watchlist owners can insert/update/delete.

### `ticker_events`

*Primary key*: `id bigserial`.

| Column | Type | Notes |
| --- | --- | --- |
| `ticker` | `text` | References `tickers(ticker)`; cascade delete when the ticker is removed. |
| `event_type` | `text` | `created`, `name_changed`, `exchange_updated`, `delisted_inferred`, etc. |
| `details` | `jsonb` | Payload describing the change (previous/current values, actor, timestamp). |
| `created_at` | `timestamptz` | Auto timestamp. |

Every upsert the roster worker performs emits events so operators can audit rename/delist actions. The planner does not expose this table yet, but it is handy for future reporting/alerts.

### `watchlist_summaries`

View that exposes watchlists with ticker counts for lightweight client queries:

```
select
  id,
  name,
  slug,
  description,
  is_system,
  is_public,
  created_by,
  created_by_email,
  created_at,
  updated_at,
  coalesce((select count(*) from public.watchlist_entries we where we.watchlist_id = w.id and we.removed_at is null), 0) as ticker_count
from public.watchlists w;
```

Use it to avoid counting entries client-side when populating dropdowns. RLS inherits from the base tables.

### `sector_prompts`

| Column | Type | Notes |
| --- | --- | --- |
| `sector` | `text` (PK) | Sector label aligned with `tickers.sector`. |
| `notes` | `text` | Free-form guidance injected into Stage 2 prompts. |

### `runs`

*Primary key*: `id uuid` generated with `gen_random_uuid()`.

| Column | Type | Default | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | `gen_random_uuid()` | Identifier returned to the UI when a run starts. |
| `created_at` | `timestamptz` | `now()` | Creation timestamp. |
| `status` | `text` | `'queued'` | Allowed values: `queued`, `running`, `done`, `failed`. |
| `notes` | `text` | `null` | Optional metadata (e.g., user, budget). |
| `stop_requested` | `boolean` | `false` | Workers should check this before processing the next batch. |
| `created_by` | `uuid` | `null` | Populated by the `runs-create` edge function to record who launched the batch for quota enforcement.【F:supabase/functions/runs-create/index.ts†L232-L330】 |
| `created_by_email` | `text` | `null` | Snapshot of the operator’s email for audit trails.【F:supabase/functions/runs-create/index.ts†L232-L330】 |
| `watchlist_id` | `uuid` | `null` | References `watchlists(id)` whenever a run targets a named list so history can be replayed or audited.【F:supabase/functions/runs-create/index.ts†L321-L363】 |

Indexes on `created_by` and `created_at` support daily quota checks (`sql/009_member_access.sql`).【F:sql/009_member_access.sql†L1-L6】

Set `RUNS_DAILY_LIMIT` (default `5`) in the edge runtime to cap how many batches a user can initiate within a rolling 24‑hour window; exceeding the quota triggers a `429` from `runs-create`.【F:supabase/functions/runs-create/index.ts†L104-L194】

### `run_items`

Composite primary key: `(run_id, ticker)`.

| Column | Type | Default | Notes |
| --- | --- | --- | --- |
| `run_id` | `uuid` | — | References `runs(id)`. |
| `ticker` | `text` | — | References `tickers(ticker)`. |
| `stage` | `int` | `0` | Highest completed stage (0=not started, 1=triage, 2=medium, 3=deep). |
| `label` | `text` | `null` | Outcome label from the last completed stage. |
| `stage2_go_deep` | `boolean` | `null` | Stage&nbsp;2 verdict flag recorded when the thematic scoring worker runs. |
| `status` | `text` | `'pending'` | `pending`, `ok`, `skipped`, or `failed`. |
| `spend_est_usd` | `numeric(12,4)` | `0` | Running total of estimated spend for this ticker. |
| `updated_at` | `timestamptz` | `now()` | Touch on each stage completion. |

### `run_schedules`

*Primary key*: `id uuid`.

| Column | Type | Default | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | `gen_random_uuid()` | Stable identifier for the schedule row. |
| `run_id` | `uuid` | — | References `runs(id)` and must be unique so each run has at most one schedule. |
| `label` | `text` | — | Optional operator-friendly descriptor for admin UIs. |
| `cadence_seconds` | `integer` | `3600` | Minimum of 60 seconds. Controls how frequently the dispatcher invokes `runs-continue`. |
| `stage1_limit` | `integer` | `8` | Batch size for Stage&nbsp;1 when the scheduler triggers (1–25). |
| `stage2_limit` | `integer` | `4` | Batch size for Stage&nbsp;2 when the scheduler triggers. |
| `stage3_limit` | `integer` | `2` | Batch size for Stage&nbsp;3 when the scheduler triggers. |
| `max_cycles` | `integer` | `1` | Number of sequential `runs-continue` cycles per dispatch (1–10). |
| `active` | `boolean` | `true` | Whether the dispatcher should consider this schedule. |
| `last_triggered_at` | `timestamptz` | — | Updated whenever the dispatcher runs; used to enforce cadence spacing. |
| `created_at` | `timestamptz` | `now()` | Creation timestamp. |
| `updated_at` | `timestamptz` | `now()` | Updated by edge functions when the schedule changes. |

`sql/011_run_schedules.sql` provisions the table, indexes, and validation constraints. Operators call
the `runs-schedule` edge function to create or update rows, while the unattended dispatcher
(`runs-dispatch`) polls this table on a cron cadence and invokes `runs-continue` with the
stored limits. Both endpoints expect an `AUTOMATION_SERVICE_SECRET` environment variable so
service-to-service calls can bypass interactive auth without exposing the Supabase service role key.

### `run_feedback`

*Primary key*: `id uuid` generated via `gen_random_uuid()`.

| Column | Type | Default | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | `gen_random_uuid()` | Stable identifier for the follow-up item. |
| `run_id` | `uuid` | — | References `runs(id)`; cascades on delete. |
| `ticker` | `text` | `null` | Optional ticker reference. A `SET NULL` constraint keeps the request if a ticker is removed. |
| `question_text` | `text` | — | Required free-form prompt submitted by the operator/member. |
| `status` | `text` | `'pending'` | Enum enforced by a check constraint: `pending`, `in_progress`, `resolved`, or `dismissed`. |
| `response_text` | `text` | `null` | Optional analyst response or resolution note. |
| `context` | `jsonb` | `null` | Arbitrary metadata (UI origin, browser hints, automation context). |
| `created_by` | `uuid` | `null` | References `auth.users(id)` when a member submits the request. |
| `created_by_email` | `text` | `null` | Captured for quick triage in dashboards. |
| `resolved_by` | `uuid` | `null` | References `auth.users(id)` if an admin resolves/dismisses the item. |
| `resolved_by_email` | `text` | `null` | Audit trail for the resolver. |
| `created_at` | `timestamptz` | `now()` | Submission timestamp. |
| `updated_at` | `timestamptz` | `now()` | Touched on insert/update. |
| `resolved_at` | `timestamptz` | `null` | Populated when `status` transitions to `resolved` or `dismissed`. |

`sql/012_run_feedback.sql` provisions the table, indexes by run/status/actor, and exposes the
`run_feedback_for_run` helper for the planner UI. The `runs-feedback` edge function verifies the
caller (member or automation secret), validates the ticker belongs to the run, inserts rows, and
returns both the fresh item and, on `GET`, the full queue for operators monitoring manual follow-ups.

### `focus_question_templates`

*Primary key*: `id bigserial`.

| Column | Type | Default | Notes |
| --- | --- | --- | --- |
| `id` | `bigserial` | — | Surrogate key for each reusable focus prompt. |
| `slug` | `text` | — | Unique handle used by the planner and automation payloads. |
| `label` | `text` | — | Short operator-friendly name surfaced in the planner checkbox list. |
| `question` | `text` | — | Full prompt rendered when a template is queued. |
| `created_at` | `timestamptz` | `now()` | Managed automatically. |
| `updated_at` | `timestamptz` | `now()` | Maintained by the shared `set_updated_at` trigger. |

`sql/015_focus_questions.sql` provisions the catalog and seeds three starter prompts covering
capital allocation, growth durability, and risk monitoring so operators have defaults on first run.【F:sql/015_focus_questions.sql†L1-L8】【F:sql/015_focus_questions.sql†L71-L76】
The planner consumes this list to render the checkbox grid for admins configuring follow-up
automation.【F:assets/planner.js†L3107-L3150】

### `focus_question_requests`

*Primary key*: `id uuid` generated via `gen_random_uuid()`.

| Column | Type | Default | Notes |
| --- | --- | --- | --- |
| `id` | `uuid` | `gen_random_uuid()` | Stable identifier for each queued focus prompt. |
| `run_id` | `uuid` | — | References `runs(id)`; cascades on delete so orphaned rows disappear with the run.【F:sql/015_focus_questions.sql†L10-L29】 |
| `ticker` | `text` | — | References `tickers(ticker)`; required so automation can fetch Stage 1–3 context.【F:sql/015_focus_questions.sql†L12-L15】 |
| `template_id` | `bigint` | `null` | Optional reference back to `focus_question_templates.id`; preserved on template deletion via `SET NULL`. |
| `question` | `text` | — | Canonical prompt text (template copy or ad-hoc freeform request). |
| `status` | `text` | `'pending'` | Enum enforced by a check constraint: `pending`, `queued`, `in_progress`, `answered`, `failed`, or `cancelled`. |
| `answer` | `jsonb` | `null` | Full structured payload returned by the LLM, including citations. |
| `answer_text` | `text` | `null` | Human-readable summary shown in the planner table. |
| `tokens_in` / `tokens_out` | `int` | `null` | Usage metrics recorded by the automation worker. |
| `cost_usd` | `numeric(12,4)` | `null` | USD spend tracked alongside the Stage&nbsp;4 ledger entry. |
| `cache_hit` | `boolean` | `false` | Flags whether the response came from the shared completion cache. |
| `metadata` | `jsonb` | `null` | Automation metadata (retrieval snippets, usage, errors). |
| `created_by` / `created_by_email` | `uuid` / `text` | `null` | Captures the submitting admin for audit trails. |
| `answered_by` / `answered_by_email` | `uuid` / `text` | `null` | Populated when automation resolves the request. |
| `created_at` | `timestamptz` | `now()` | Submission timestamp. |
| `updated_at` | `timestamptz` | `now()` | Maintained by the `touch_focus_request` trigger on update. |
| `answered_at` | `timestamptz` | `null` | Set when automation marks the item `answered`. |

The migration adds run/ticker/time indexes plus a trigger to keep `updated_at` current.【F:sql/015_focus_questions.sql†L33-L50】
The `run_focus_summary` helper provides aggregated counts consumed by the planner dashboard and
`runs-focus` endpoint.【F:sql/015_focus_questions.sql†L52-L69】【F:assets/planner.js†L3287-L3336】
Admins interact with the queue through the `runs-focus` edge function (`GET` lists templates,
requests, and metrics; `POST` enqueues template and custom prompts after validating the run/ticker
relationship).【F:supabase/functions/runs-focus/index.ts†L222-L358】【F:supabase/functions/runs-focus/index.ts†L360-L438】
The `focus-consume` worker processes pending rows, fetches Stage&nbsp;1–3 context, performs retrieval,
records answers/costs, and updates status transitions while logging failures for observability.【F:supabase/functions/focus-consume/index.ts†L1-L364】

### `answers`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `bigserial` | Primary key. |
| `run_id` | `uuid` | Foreign key → `runs`. |
| `ticker` | `text` | Foreign key → `tickers`. |
| `stage` | `int` | Stage indicator for the response. |
| `question_group` | `text` | Thematic grouping (triage, medium, moat, etc.). |
| `answer_json` | `jsonb` | Structured payload (scores, flags, etc.). |
| `answer_text` | `text` | Optional narrative for final reports. |
| `tokens_in` | `int` | Prompt token usage from OpenAI API. |
| `tokens_out` | `int` | Completion token usage. |
| `cost_usd` | `numeric(12,4)` | USD spend for the call. |
| `created_at` | `timestamptz` | Timestamp for the response. |

### `cost_ledger`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `bigserial` | Primary key. |
| `run_id` | `uuid` | Batch identifier. |
| `stage` | `int` | Stage number the cost corresponds to. |
| `model` | `text` | Model identifier (e.g., `gpt-4o-mini`). |
| `tokens_in` | `bigint` | Prompt tokens (aggregated per log entry). |
| `tokens_out` | `bigint` | Completion tokens. |
| `cost_usd` | `numeric(12,4)` | USD spend at logging time. |
| `created_at` | `timestamptz` | Timestamp of the ledger entry. |

### `cached_completions`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `uuid` | Primary key generated via `gen_random_uuid()`. |
| `model_slug` | `text` | Identifier for the model that produced the response. |
| `cache_key` | `text` | Stage/ticker hash that groups equivalent prompts. Unique per model. |
| `prompt_hash` | `text` | SHA-256 hash of the request payload for audit/debugging. |
| `request_body` | `jsonb` | Exact body sent to the model (messages, temperature, etc.). |
| `response_body` | `jsonb` | Full model response (choices, usage metadata). |
| `usage` | `jsonb` | Raw token usage captured from the provider. |
| `context` | `jsonb` | Optional metadata (retrieval citations, dependency notes) saved alongside the response. |
| `tags` | `text[]` | Reserved for future segmentation of cache entries. |
| `hit_count` | `int` | Number of times the cache entry has been reused. |
| `last_hit_at` | `timestamptz` | Timestamp of the most recent cache reuse. |
| `expires_at` | `timestamptz` | Optional expiry timestamp computed from the TTL controls. |
| `created_at` | `timestamptz` | Insert timestamp. |

Stage 1–3 workers consult this table before making model calls. When the request body matches
an existing `cache_key`, the worker reuses the stored response, marks the hit, and records zero
incremental cost for the run. Otherwise the fresh response is inserted with a TTL governed by
`AI_CACHE_TTL_MINUTES` (or the stage-specific overrides) so deterministic prompts can be reused
across future batches without double spending.

### `docs`

*Primary key*: `id uuid` generated with `gen_random_uuid()`.

| Column | Type | Default | Notes |
| --- | --- | --- | --- |
| `ticker` | `text` | — | References `tickers(ticker)`; nullable for general-market research. |
| `title` | `text` | — | Human-readable label shown in the uploader and citations. |
| `source_type` | `text` | `null` | Free-form category (10-K, investor letter, transcript, etc.). |
| `published_at` | `timestamptz` | `null` | Optional publication timestamp surfaced in the UI. |
| `source_url` | `text` | `null` | Canonical URL for the underlying document. |
| `storage_path` | `text` | — | Supabase Storage path (e.g., `raw/MSFT/2024-10-10-letter.pdf`). |
| `uploaded_by` | `uuid` | `null` | References `auth.users(id)` for audit trails. |
| `status` | `text` | `'pending'` | Processing lifecycle (`pending`, `processed`, `failed`). |
| `chunk_count` | `int` | `0` | Populated by the chunking job. |
| `token_count` | `int` | `0` | Sum of token estimates across stored chunks. |
| `last_error` | `text` | `null` | Last processing failure captured by the edge worker. |
| `processed_at` | `timestamptz` | `null` | Timestamp of the most recent successful chunk+embed run. |
| `created_at` / `updated_at` | `timestamptz` | `now()` | Managed timestamps. |

Uploads are saved to the Supabase Storage bucket `docs` under `raw/<ticker>/...` by the admin console at `/docs/index.html`.

### `doc_chunks`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `bigserial` | Primary key. |
| `doc_id` | `uuid` | References `docs(id)`; cascades on delete. |
| `ticker` | `text` | Denormalised symbol for fast filtering. |
| `source` | `text` | Optional legacy label retained for back-compat. |
| `chunk_index` | `int` | Sequential index (0-based) assigned by the chunking worker. |
| `chunk` | `text` | Plain-text snippet used for retrieval-augmented prompts. |
| `token_length` | `int` | Approximate token count used for budgeting. |
| `embedding` | `vector(1536)` | pgvector representation generated via `text-embedding-3-small`. |

An IVFFlat index on `embedding` accelerates similarity search for the retrieval helper.

### `error_logs`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `bigserial` | Primary key. |
| `context` | `text` | Logical component (e.g., `docs-process`). |
| `message` | `text` | Short description of the failure. |
| `payload` | `jsonb` | Structured blob (request params, stack traces). |
| `run_id` | `uuid` | Optional pointer to the affected run. |
| `ticker` | `text` | Optional ticker reference for per-run issues. |
| `stage` | `int` | Stage that generated the failure (`null` for ingestion or misc). |
| `prompt_id` | `text` | Prompt or function identifier captured by the worker. |
| `retry_count` | `int` | Number of attempts recorded when the worker retried. |
| `status_code` | `int` | HTTP status returned by the worker (if applicable). |
| `metadata` | `jsonb` | Supplemental structured context (e.g., doc ID, embeddings). |
| `created_at` | `timestamptz` | Defaults to `now()`. |

Reuse this table for worker instrumentation (Stages 12–13) by logging run/ticker context, prompt identifiers, and structured payloads for observability dashboards.

The Postgres RPC `match_doc_chunks(query_embedding double precision[], query_ticker text, match_limit int)` converts an array
of floats into a `vector(1536)` and returns the top-k snippets ordered by cosine distance alongside document metadata. Workers
invoke it after computing embeddings so they can inject `[D1]`-style citations into prompts.

### `analysis_dimensions`

*Primary key*: `id uuid` generated with `gen_random_uuid()`.

| Column | Type | Default | Notes |
| --- | --- | --- | --- |
| `slug` | `text` | — | Unique identifier (e.g., `financial_resilience`). Used in prompts and dashboards. |
| `name` | `text` | — | Human-readable label displayed in scorecards. |
| `description` | `text` | `null` | Optional blurb describing what the dimension captures. |
| `stage` | `int` | `3` | Stage the dimension applies to (defaults to Stage&nbsp;3 deep dives). |
| `order_index` | `int` | `0` | Ordering key for scorecards. |
| `weight` | `numeric(8,4)` | `1` | Weight applied when averaging question scores. |
| `color_bad` / `color_neutral` / `color_good` | `text` | Palette hex codes used for UI badges. |
| `is_active` | `boolean` | `true` | Toggle to deactivate a dimension without removing history. |
| `metadata` | `jsonb` | `'{}'` | Free-form JSON for downstream tuning (e.g., signal hints). |
| `created_at` / `updated_at` | `timestamptz` | `now()` | Managed timestamps. |

Seed and maintain this table via `/sql/007_question_registry.sql` so serverless workers and dashboards stay aligned.

### `analysis_questions`

*Primary key*: `id uuid`.

| Column | Type | Default | Notes |
| --- | --- | --- | --- |
| `dimension_id` | `uuid` | — | References `analysis_dimensions(id)`. |
| `slug` | `text` | — | Stable question identifier (e.g., `fin_core_liquidity`). |
| `stage` | `int` | `3` | Stage the question executes in. |
| `order_index` | `int` | `0` | Controls execution order (dependencies should come later). |
| `prompt` | `text` | — | Primary instruction block injected into Stage&nbsp;3 prompts. |
| `guidance` | `text` | `null` | Optional extra heuristics appended below the prompt. |
| `weight` | `numeric(8,4)` | `1` | Contribution to weighted averages. |
| `answer_schema` | `jsonb` | default schema | Expected JSON structure returned by the model. Workers stringify this in the prompt. |
| `depends_on` | `text[]` | `{}` | Array of prerequisite question slugs; used to feed dependency notes back to the model. |
| `tags` | `text[]` | `{}` | Category hints (e.g., `['debt','liquidity']`). |
| `is_active` | `boolean` | `true` | Toggle without deleting history. |
| `metadata` | `jsonb` | `'{}'` | Optional extras (model hints, thresholds). |
| `created_at` / `updated_at` | `timestamptz` | `now()` | Managed timestamps. |

### `analysis_question_results`

Composite primary key: `(run_id, ticker, question_id)`.

| Column | Type | Notes |
| --- | --- | --- |
| `run_id` | `uuid` | References `runs`. |
| `ticker` | `text` | References `tickers`. |
| `question_id` | `uuid` | References `analysis_questions`. |
| `question_slug` | `text` | Convenience copy for fast lookups. |
| `dimension_id` | `uuid` | References `analysis_dimensions`. |
| `stage` | `int` | Stage executed (normally 3). |
| `verdict` | `text` | Normalised verdict string (`bad`, `neutral`, `good`). |
| `score` | `numeric(8,4)` | 0–100 scale when provided by the model. |
| `weight` | `numeric(8,4)` | Question weight at execution time. |
| `color` | `text` | Color applied in the UI (mirrors dimension palette). |
| `summary` | `text` | Short rationale summarising the answer. |
| `answer` | `jsonb` | Raw structured output returned by the model. |
| `tags` | `text[]` | Normalised tag list from the response. |
| `dependencies` | `text[]` | Dependency slugs referenced when generating the prompt. |
| `created_at` / `updated_at` | `timestamptz` | Timestamped at execution. |

Workers upsert into this table so the browser can build dependency graphs without re-querying the model.

### `analysis_dimension_scores`

Composite primary key: `(run_id, ticker, dimension_id)`.

| Column | Type | Notes |
| --- | --- | --- |
| `run_id` | `uuid` | References `runs`. |
| `ticker` | `text` | References `tickers`. |
| `dimension_id` | `uuid` | References `analysis_dimensions`. |
| `verdict` | `text` | Weighted verdict computed across question results. |
| `score` | `numeric(8,4)` | Final ensemble score rendered in dashboards (0–100). |
| `ensemble_score` | `numeric(8,4)` | Duplicate of `score` for clarity in downstream exports. |
| `llm_score` | `numeric(8,4)` | Raw LLM-weighted score prior to deterministic blending. |
| `factor_score` | `numeric(8,4)` | Deterministic factor contribution (0–100) averaged across linked factors. |
| `weight` | `numeric(8,4)` | Total weight aggregated for the dimension (LLM + factor weights). |
| `llm_weight` | `numeric(8,4)` | Weight attributed to LLM evidence in the ensemble. |
| `factor_weight` | `numeric(8,4)` | Weight attributed to deterministic factors in the ensemble. |
| `color` | `text` | Tone used in dashboards (defaults to the dimension palette). |
| `summary` | `text` | Concise roll-up summarising the dimension. |
| `tags` | `text[]` | Union of tags from contributing questions. |
| `details` | `jsonb` | Array of question-level metadata (verdict, score, answer snapshot). |
| `factor_breakdown` | `jsonb` | Array of factor contributors `{ slug, name, score, value, as_of, metadata }`. |
| `created_at` / `updated_at` | `timestamptz` | Timestamped at aggregation time. |

The Universe and ticker dashboards read from this table to render color-coded scorecards without parsing raw answer blobs.
The new ensemble fields expose how LLM reasoning and deterministic factors blended for each dimension.

### `scoring_factors`

*Primary key*: `id uuid` (generated).

| Column | Type | Notes |
| --- | --- | --- |
| `slug` | `text` | Stable identifier (e.g., `revenue_growth_yoy`). |
| `name` | `text` | Human-friendly label surfaced in the UI. |
| `description` | `text` | Optional summary of what the factor measures. |
| `category` | `text` | Optional grouping (growth, leverage, valuation, etc.). |
| `direction` | `text` | Either `higher_better` or `lower_better` to guide scoring. |
| `scale_min` / `scale_max` | `numeric` | Optional bounds used to normalise raw values to 0–100. |
| `weight` | `numeric(10,4)` | Default influence when blended into dimension ensembles. |
| `metadata` | `jsonb` | Arbitrary configuration (units, ideal thresholds, tolerances). |
| `created_at` / `updated_at` | `timestamptz` | Managed automatically (trigger `touch_updated_at`). |

Add or update rows here whenever you introduce new deterministic metrics that should influence the ensemble score.

### `dimension_factor_links`

Composite primary key: `(dimension_id, factor_id)`.

| Column | Type | Notes |
| --- | --- | --- |
| `dimension_id` | `uuid` | References `analysis_dimensions`. |
| `factor_id` | `uuid` | References `scoring_factors`. |
| `weight` | `numeric(10,4)` | Relative influence of this factor for the dimension. |
| `created_at` / `updated_at` | `timestamptz` | Managed automatically. |

Stage 3 workers load this mapping once per run to understand which factors to pull when blending ensemble scores.

### `ticker_factor_snapshots`

Composite primary key: `(ticker, factor_id, as_of)`.

| Column | Type | Notes |
| --- | --- | --- |
| `ticker` | `text` | References `tickers`. |
| `factor_id` | `uuid` | References `scoring_factors`. |
| `as_of` | `date` | Effective date for the metric (default `current_date`). |
| `value` | `numeric` | Raw numeric measurement (same units as defined in `scoring_factors`). |
| `score` | `numeric` | Optional pre-computed 0–100 score (otherwise derived from value + metadata). |
| `source` | `text` | Source identifier (e.g., `alphavantage`, `manual`, `seed`). |
| `notes` | `text` | Optional commentary from the ingestion job. |
| `metadata` | `jsonb` | Feed-specific payload (currency, adjustments, etc.). |
| `created_at` | `timestamptz` | Timestamp inserted. |

The helper view `ticker_factor_latest` selects the most recent snapshot per `(ticker, factor_id)` for fast access inside Supabase edge functions.
