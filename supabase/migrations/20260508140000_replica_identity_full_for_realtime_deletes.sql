-- Ensure Realtime DELETE events include row data (id) for clients.
-- Without this, payload.old may be empty and the UI can't remove deleted rows.

alter table if exists public.feeds replica identity full;
alter table if exists public.contractions replica identity full;

