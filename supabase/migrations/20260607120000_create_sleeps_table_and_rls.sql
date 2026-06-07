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
