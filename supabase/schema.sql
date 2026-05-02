-- Run this in Supabase: SQL Editor → New query → Run
-- Enable anonymous sign-in: Authentication → Providers → Anonymous → On

create table if not exists public.contractions (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  end_ms bigint not null,
  intensity smallint not null check (intensity between 1 and 10),
  duration_sec int null,
  created_at timestamptz not null default now()
);

create index if not exists contractions_user_end
  on public.contractions (user_id, end_ms desc);

alter table public.contractions enable row level security;

drop policy if exists "contractions_select_own" on public.contractions;
drop policy if exists "contractions_insert_own" on public.contractions;
drop policy if exists "contractions_update_own" on public.contractions;
drop policy if exists "contractions_delete_own" on public.contractions;

create policy "contractions_select_own"
  on public.contractions for select
  using (auth.uid() = user_id);

create policy "contractions_insert_own"
  on public.contractions for insert
  with check (auth.uid() = user_id);

create policy "contractions_update_own"
  on public.contractions for update
  using (auth.uid() = user_id);

create policy "contractions_delete_own"
  on public.contractions for delete
  using (auth.uid() = user_id);
