-- Live sync across devices: broadcast row changes to subscribed clients.
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
