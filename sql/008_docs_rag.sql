create extension if not exists vector;

create table if not exists public.docs (
  id uuid primary key default gen_random_uuid(),
  ticker text references public.tickers(ticker) on delete cascade,
  title text not null,
  source_type text,
  published_at timestamptz,
  source_url text,
  storage_path text not null unique,
  uploaded_by uuid references auth.users(id),
  status text default 'pending',
  chunk_count int default 0,
  token_count int default 0,
  last_error text,
  processed_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

alter table public.doc_chunks
  add column if not exists doc_id uuid references public.docs(id) on delete cascade,
  add column if not exists chunk_index int default 0,
  add column if not exists token_length int default 0,
  add column if not exists embedding vector(1536),
  alter column source drop not null;

create index if not exists doc_chunks_doc_id_idx on public.doc_chunks(doc_id);
create index if not exists doc_chunks_ticker_idx on public.doc_chunks(ticker);
create index if not exists doc_chunks_embedding_idx on public.doc_chunks using ivfflat (embedding vector_cosine_ops) with (lists = 100);

create table if not exists public.error_logs (
  id bigserial primary key,
  context text,
  message text,
  payload jsonb,
  created_at timestamptz default now()
);

create or replace function public.match_doc_chunks(
  query_embedding double precision[],
  query_ticker text,
  match_limit int default 6
)
returns table (
  doc_id uuid,
  chunk_index int,
  chunk text,
  ticker text,
  similarity double precision,
  token_length int,
  source_type text,
  title text,
  published_at timestamptz,
  source_url text,
  storage_path text
)
language plpgsql
as $$
declare
  embedding vector(1536);
begin
  if query_embedding is null then
    raise exception 'query_embedding is required';
  end if;

  embedding := query_embedding::vector(1536);

  return query
    select
      c.doc_id,
      c.chunk_index,
      c.chunk,
      c.ticker,
      1 - (c.embedding <=> embedding) as similarity,
      c.token_length,
      d.source_type,
      d.title,
      d.published_at,
      d.source_url,
      d.storage_path
    from public.doc_chunks c
    join public.docs d on d.id = c.doc_id
    where (query_ticker is null or c.ticker = query_ticker)
      and c.embedding is not null
    order by c.embedding <=> embedding
    limit greatest(match_limit, 1);
end;
$$;
