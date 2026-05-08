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

