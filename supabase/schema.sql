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

-- Live updates across tabs/browsers (Supabase Realtime)
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'contractions'
  ) then
    alter publication supabase_realtime add table public.contractions;
  end if;
end $$;

-- ================
-- Feeds (breast L/R)
-- ================

create table if not exists public.feeds (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  started_at_ms bigint not null,
  side1 text not null check (side1 in ('L','R')),
  duration1_sec int not null check (duration1_sec >= 0),
  side2 text null check (side2 in ('L','R')),
  duration2_sec int null check (duration2_sec >= 0),
  created_at timestamptz not null default now()
);

create index if not exists feeds_user_started
  on public.feeds (user_id, started_at_ms desc);

alter table public.feeds enable row level security;

drop policy if exists "feeds_select_own" on public.feeds;
drop policy if exists "feeds_insert_own" on public.feeds;
drop policy if exists "feeds_update_own" on public.feeds;
drop policy if exists "feeds_delete_own" on public.feeds;

create policy "feeds_select_own"
  on public.feeds for select
  using (auth.uid() = user_id);

create policy "feeds_insert_own"
  on public.feeds for insert
  with check (auth.uid() = user_id);

create policy "feeds_update_own"
  on public.feeds for update
  using (auth.uid() = user_id);

create policy "feeds_delete_own"
  on public.feeds for delete
  using (auth.uid() = user_id);

-- Realtime
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'feeds'
  ) then
    alter publication supabase_realtime add table public.feeds;
  end if;
end $$;

-- ================
-- Sleep sessions
-- ================

create table if not exists public.sleeps (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  started_at_ms bigint not null,
  ended_at_ms bigint null check (ended_at_ms is null or ended_at_ms >= started_at_ms),
  quick_log boolean not null default false,
  created_at timestamptz not null default now()
);

create index if not exists sleeps_user_started
  on public.sleeps (user_id, started_at_ms desc);

alter table public.sleeps enable row level security;

drop policy if exists "sleeps_select_own" on public.sleeps;
drop policy if exists "sleeps_insert_own" on public.sleeps;
drop policy if exists "sleeps_update_own" on public.sleeps;
drop policy if exists "sleeps_delete_own" on public.sleeps;

create policy "sleeps_select_own"
  on public.sleeps for select
  using (auth.uid() = user_id);

create policy "sleeps_insert_own"
  on public.sleeps for insert
  with check (auth.uid() = user_id);

create policy "sleeps_update_own"
  on public.sleeps for update
  using (auth.uid() = user_id);

create policy "sleeps_delete_own"
  on public.sleeps for delete
  using (auth.uid() = user_id);

alter table public.sleeps replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'sleeps'
  ) then
    alter publication supabase_realtime add table public.sleeps;
  end if;
end $$;
