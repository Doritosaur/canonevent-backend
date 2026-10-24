-- Audio is now uploaded last, after the user saves the reviewed transcript, so a memory can exist
-- (fully searchable) before, or without, its audio. audio_uploaded_at says whether the object is in R2.
--
-- Processing (chunk + embed) is claimed atomically so concurrent triggers can't both run, and a
-- run that died mid-way (function killed, process restarted) becomes claimable again after p_stale.

alter table public.memories
  add column audio_uploaded_at      timestamptz,
  add column processing_started_at  timestamptz,
  add column processing_attempts    integer not null default 0;

-- Memories created before this column existed already had their audio uploaded.
update public.memories set audio_uploaded_at = created_at where audio_key is not null;

create or replace function public.claim_memory_processing(
  p_id           uuid,
  p_stale        interval default interval '10 minutes',
  p_allow_ready  boolean  default false
)
returns setof public.memories
language sql
as $$
  update public.memories
  set processing_status     = 'processing',
      processing_error      = null,
      processing_started_at = now(),
      processing_attempts   = processing_attempts + 1
  where id = p_id
    and (
      processing_status in ('pending', 'failed')
      or (processing_status = 'processing' and processing_started_at < now() - p_stale)
      or (p_allow_ready and processing_status = 'ready')
    )
  returning *;
$$;

-- Only the worker (service role) may claim; clients must not be able to flip processing state.
revoke execute on function public.claim_memory_processing(uuid, interval, boolean) from public, anon, authenticated;
grant  execute on function public.claim_memory_processing(uuid, interval, boolean) to service_role;
