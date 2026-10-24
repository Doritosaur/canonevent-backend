-- Personal decision memory: core schema, RLS, indexes, hybrid search.
-- Embedding model: BAAI/bge-m3 (1024 dimensions).

create extension if not exists vector with schema extensions;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- profiles: app-level user row, mapped 1:1 to the auth provider's user id.
-- Everything else references profiles(id), not auth.users, to keep a future
-- auth-provider migration cheap.
-- ---------------------------------------------------------------------------

create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text,
  created_at  timestamptz not null default now()
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- memories: one standalone recording or note.
-- id is client-generatable so create calls can be retried idempotently.
-- ---------------------------------------------------------------------------

create table public.memories (
  id                      uuid primary key default gen_random_uuid(),
  user_id                 uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  title                   text,
  content                 text not null default '',
  input_type              text not null check (input_type in ('voice', 'text')),
  audio_key               text,
  audio_content_type      text,
  language                text,
  transcription_provider  text,
  occurred_at             timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  processing_status       text not null default 'pending'
                            check (processing_status in ('pending', 'processing', 'ready', 'failed')),
  processing_error        text,
  -- lets memory_chunks enforce that its user_id matches the parent memory
  unique (id, user_id)
);

create trigger memories_set_updated_at
  before update on public.memories
  for each row execute function public.set_updated_at();

create index memories_user_created_idx  on public.memories (user_id, created_at desc);
create index memories_user_occurred_idx on public.memories (user_id, occurred_at desc);
create index memories_status_idx        on public.memories (processing_status)
  where processing_status in ('pending', 'processing');

-- ---------------------------------------------------------------------------
-- memory_chunks: internal retrieval representation, written by the worker
-- (service role) only. 'simple' text-search config because memories may be
-- in Hindi or other Indic languages with no stemmer available.
-- ---------------------------------------------------------------------------

create table public.memory_chunks (
  id               uuid primary key default gen_random_uuid(),
  memory_id        uuid not null,
  user_id          uuid not null,
  chunk_index      integer not null,
  content          text not null,
  embedding        extensions.vector(1024),
  embedding_model  text,
  fts              tsvector generated always as (to_tsvector('simple', content)) stored,
  created_at       timestamptz not null default now(),
  foreign key (memory_id, user_id)
    references public.memories (id, user_id) on delete cascade,
  unique (memory_id, chunk_index)
);

create index memory_chunks_user_idx   on public.memory_chunks (user_id);
create index memory_chunks_fts_idx    on public.memory_chunks using gin (fts);
create index memory_chunks_vector_idx on public.memory_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

-- ---------------------------------------------------------------------------
-- conversations / messages
-- ---------------------------------------------------------------------------

create table public.conversations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  title       text,
  created_at  timestamptz not null default now()
);

create index conversations_user_idx on public.conversations (user_id, created_at desc);

create table public.messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.conversations (id) on delete cascade,
  user_id          uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  role             text not null check (role in ('user', 'assistant', 'system')),
  content          text not null,
  created_at       timestamptz not null default now()
);

create index messages_conversation_idx on public.messages (conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.profiles       enable row level security;
alter table public.memories       enable row level security;
alter table public.memory_chunks  enable row level security;
alter table public.conversations  enable row level security;
alter table public.messages       enable row level security;

create policy profiles_select_own on public.profiles
  for select using (id = auth.uid());

create policy memories_select_own on public.memories
  for select using (user_id = auth.uid());
create policy memories_insert_own on public.memories
  for insert with check (user_id = auth.uid());
create policy memories_update_own on public.memories
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy memories_delete_own on public.memories
  for delete using (user_id = auth.uid());

-- Chunks are read-only for clients; the worker writes them with the service role.
create policy memory_chunks_select_own on public.memory_chunks
  for select using (user_id = auth.uid());

create policy conversations_select_own on public.conversations
  for select using (user_id = auth.uid());
create policy conversations_insert_own on public.conversations
  for insert with check (user_id = auth.uid());
create policy conversations_update_own on public.conversations
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy conversations_delete_own on public.conversations
  for delete using (user_id = auth.uid());

create policy messages_select_own on public.messages
  for select using (user_id = auth.uid());
create policy messages_insert_own on public.messages
  for insert with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id and c.user_id = auth.uid()
    )
  );

-- ---------------------------------------------------------------------------
-- Hybrid search: vector + keyword, fused with Reciprocal Rank Fusion.
-- security invoker, so RLS scopes results to the caller; the explicit
-- user_id filter is defense in depth. Call it with the user's JWT, not the
-- service role (auth.uid() would be null and nothing is returned).
-- ---------------------------------------------------------------------------

create or replace function public.hybrid_search(
  query_embedding  extensions.vector(1024),
  query_text       text,
  match_count      integer     default 20,
  date_from        timestamptz default null,
  date_to          timestamptz default null,
  rrf_k            integer     default 60
)
returns table (
  chunk_id     uuid,
  memory_id    uuid,
  chunk_index  integer,
  content      text,
  title        text,
  occurred_at  timestamptz,
  created_at   timestamptz,
  score        double precision
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with scoped as (
    select c.id, c.memory_id, c.chunk_index, c.content, c.embedding, c.fts,
           m.title, m.occurred_at, m.created_at
    from memory_chunks c
    join memories m on m.id = c.memory_id and m.user_id = c.user_id
    where c.user_id = auth.uid()
      and m.processing_status = 'ready'
      and (date_from is null or coalesce(m.occurred_at, m.created_at) >= date_from)
      and (date_to   is null or coalesce(m.occurred_at, m.created_at) <  date_to)
  ),
  semantic as (
    select s.id,
           row_number() over (order by s.embedding <=> query_embedding) as rank
    from scoped s
    where s.embedding is not null
    order by s.embedding <=> query_embedding
    limit match_count * 2
  ),
  -- OR together every term of the question; an AND query would almost never
  -- match a natural-language question.
  kw_query as (
    select to_tsquery(
      'simple',
      coalesce((
        select string_agg(
                 '''' || replace(replace(term, '\', '\\'), '''', '''''') || '''',
                 ' | ')
        from unnest(tsvector_to_array(to_tsvector('simple', coalesce(query_text, '')))) as term
      ), '')
    ) as q
  ),
  keyword as (
    select s.id,
           row_number() over (order by ts_rank_cd(s.fts, k.q) desc) as rank
    from scoped s, kw_query k
    where s.fts @@ k.q
    order by ts_rank_cd(s.fts, k.q) desc
    limit match_count * 2
  ),
  fused as (
    select coalesce(sem.id, kw.id) as id,
           coalesce(1.0 / (rrf_k + sem.rank), 0.0)
         + coalesce(1.0 / (rrf_k + kw.rank), 0.0) as score
    from semantic sem
    full outer join keyword kw on kw.id = sem.id
  )
  select s.id, s.memory_id, s.chunk_index, s.content, s.title,
         s.occurred_at, s.created_at, f.score::double precision
  from fused f
  join scoped s on s.id = f.id
  order by f.score desc
  limit match_count;
$$;

grant execute on function public.hybrid_search to authenticated;
