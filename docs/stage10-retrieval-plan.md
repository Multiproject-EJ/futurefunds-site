# Stage 10: Retrieval Augmentation Implementation Plan

Stage 10 introduces retrieval-augmented generation so Stage 2 and Stage 3 analyses can cite supporting documents. The following checklist breaks down the work into deployable increments.

## 1. Document ingestion and storage
- **Uploader UI:** Build an authenticated admin-only page at `/docs/index.html` (or equivalent) where operators can upload filings, transcripts, or letters. Accept PDF, TXT, and HTML inputs; capture metadata such as ticker, source type, publish date, and URL.
- **Storage strategy:** Save raw files to Supabase Storage under a `docs/raw/` bucket. Persist metadata rows in a new `docs` table (columns: `id`, `ticker`, `title`, `source_type`, `published_at`, `source_url`, `storage_path`, `uploaded_by`, `created_at`).
- **Chunking job:** Add an Edge Function (e.g., `docs-process`) that reads uploaded files, normalises text, and segments it into ~500 token chunks with 50-token overlap. Store chunks in `doc_chunks` with embeddings, metadata (doc id, chunk index), and a precomputed token length field for budgeting.
- **Error handling:** Write failures to an `error_logs` table with payloads and stack traces so Stage 12 observability work can reuse the structure.

## 2. Embeddings and retrieval helper
- **Embedding model config:** Extend the configuration object (or create `config/models.json` if Stage 13 arrives early) with the embedding model name, price, and max tokens. Ensure the Supabase service role key has permission to call the OpenAI embeddings API.
- **RPC helper:** Implement a Postgres function `match_doc_chunks(query_text text, ticker text, match_limit int default 6)` that performs vector similarity search against the `doc_chunks.embedding` column (using `pgvector`). Return chunk text, doc metadata, similarity score, and token estimate.
- **Edge function wrapper:** Expose the RPC via a Supabase Edge handler or direct client query so Stage 2/3 workers can request top-k snippets with a latency budget < 1s.

## 3. Prompt integration and UI surfacing
- **Stage 2 prompts:** Update `supabase/functions/stage2` to fetch relevant chunks for each ticker before calling the model. Inject snippets into the prompt template under a clearly marked `Retrieved context` section with citation IDs.
- **Stage 3 prompts:** Repeat the retrieval step for Stage 3 deep dives; include citations alongside sourced quotes or data points in the rendered HTML.
- **Planner visibility:** Add retrieval hit counts and token usage to the planner dashboard so operators can monitor how much external context is injected per stage.
- **Ticker page citations:** Modify `ticker.html` to display citations, linking each snippet back to its original document using the stored metadata.

## 4. Rollout checklist
- Backfill existing filings for the current watchlist tickers to validate ingestion.
- Run load tests on the embeddings pipeline (batch of ~50 documents) to size Supabase compute requirements.
- Update `docs/changelog.md` with schema additions (`docs`, `error_logs`), new functions, and prompt modifications.
- Document operational runbooks covering how to upload new sources and how to monitor retrieval health.

Following this plan will complete Stage 10 and unblock the member-facing improvements scheduled for Stage 11.
