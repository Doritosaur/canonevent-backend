-- An assistant reply carries more than its text: the considerations and the memories it drew on.
-- Kept as JSON next to the message so a recent question can be reopened exactly as it was answered,
-- without asking the LLM again. Memory ids are re-resolved when read, so deleted memories drop out.
alter table public.messages add column meta jsonb;
