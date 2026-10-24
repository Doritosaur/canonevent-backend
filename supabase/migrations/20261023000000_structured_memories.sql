-- Structured fields extracted from a memory's content by an LLM, plus
-- follow-up outcome updates. The original transcript stays in memories.content.

alter table public.memories
  add column category  text check (category in ('Money', 'Career', 'Health', 'Relationships')),
  add column outcome   text check (outcome in ('bad', 'mixed', 'good')),
  add column summary   text,
  add column happened  text,
  add column thinking  text,
  add column learned   text,
  add column tags      text[] not null default '{}',
  add column analysis  text;

create table public.memory_updates (
  id          uuid primary key default gen_random_uuid(),
  memory_id   uuid not null,
  user_id     uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  occurred_on date not null default current_date,
  text        text not null,
  created_at  timestamptz not null default now(),
  foreign key (memory_id, user_id)
    references public.memories (id, user_id) on delete cascade
);

create index memory_updates_memory_idx on public.memory_updates (memory_id, occurred_on);

alter table public.memory_updates enable row level security;

create policy memory_updates_select_own on public.memory_updates
  for select using (user_id = auth.uid());
create policy memory_updates_insert_own on public.memory_updates
  for insert with check (user_id = auth.uid());
create policy memory_updates_delete_own on public.memory_updates
  for delete using (user_id = auth.uid());
