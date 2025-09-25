# Supabase database reference

This document captures the contract between the FutureFunds frontend and the Supabase
Postgres project. Keep the tables, policies, and triggers described below in sync whenever
schema changes are made so the static site and backend continue to agree on shapes and
access rules.

## Overview

The site ships seven application tables in the `public` schema:

| Table | Purpose |
| --- | --- |
| `profiles` | Stores metadata about each authenticated user (role, email, timestamps). |
| `memberships` | Mirrors Patreon/Stripe membership state so the site can gate premium content. |
| `universe` | Holds the research briefs that power `/universe.html` and the editor workflow. |
| `editor_prompts` | Configurable AI prompt templates surfaced in the research editor. |
| `editor_models` | Configurable AI model catalogue used by the editor UI. |
| `editor_api_credentials` | Stores AI provider secrets the editor can retrieve at runtime. |
| `stock_analysis_list` | Tracks stock analysis coverage (company, status, type, and analysis date). |

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
| `role` | `text` | `'member'` | Assign `admin` to unlock internal tooling like the research editor. The editor enforces `requireRole('admin')` before writing universe rows.【F:assets/auth.js†L441-L457】【F:assets/editor.js†L720-L773】 |
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
| `source` | `text` | `'patreon'` | Indicates the billing platform (Patreon, Stripe). |
| `created_at` | `timestamptz` | `now()` | Managed automatically. |
| `updated_at` | `timestamptz` | `now()` | Managed by `set_updated_at` trigger. |

**Policies**

- `SELECT`: `auth.uid() = user_id` so members see their own status in the account modal.【F:assets/auth.js†L218-L298】
- `INSERT` / `UPDATE`: restricted to service-role integrations that sync Patreon/Stripe data.
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
| `created_at` | `timestamptz` | `now()` | Automatically managed. |
| `updated_at` | `timestamptz` | `now()` | Managed by `set_updated_at`. |
| `created_by` | `uuid` | `auth.uid()` | Optional audit column to track editors. |

**Policies**

- `SELECT`: `is_paid_member(auth.uid())` allows members to read the archive. Consider a second policy that returns a limited preview for anonymous sessions (matching the frontend’s preview behaviour).【F:assets/universe.js†L139-L205】
- `INSERT` / `UPDATE`: `auth.uid()` with `profiles.role = 'admin'` so only staff can publish new rows (the editor enforces this on the client).【F:assets/editor.js†L720-L773】

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

### `stock_analysis_list`

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

Attach this `BEFORE UPDATE` trigger to tables with an `updated_at` column (`profiles`, `memberships`, `universe`, `editor_prompts`, `editor_models`, `stock_analysis_list`).

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
