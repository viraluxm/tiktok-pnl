-- Stable, diffable projection of everything migration 129 touches. Used by run.sh to prove the
-- migration is purely additive and that re-applying it changes nothing.
\pset format unaligned
\pset tuples_only on
select 'COL '||table_name||'.'||column_name||' '||data_type||' null='||is_nullable||' def='||coalesce(column_default,'-')
  from information_schema.columns where table_schema='public'
   and table_name in ('shift_instances','shift_claims') order by table_name, column_name;
select 'CON '||conrelid::regclass||' '||conname||' '||pg_get_constraintdef(oid)
  from pg_constraint where conrelid in ('public.shift_instances'::regclass,'public.shift_claims'::regclass)
  order by conrelid::regclass::text, conname;
select 'IDX '||indexdef from pg_indexes where schemaname='public'
   and tablename in ('shift_instances','shift_claims') order by indexname;
select 'FN  '||p.oid::regprocedure||' sec='||case when p.prosecdef then 'definer' else 'invoker' end
       ||' cfg='||coalesce(array_to_string(p.proconfig,','),'-')
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('lensed_approve_shift_pickup','lensed_cancel_shift_offer') order by 1;
select 'ACL '||p.oid::regprocedure||' '||coalesce(array_to_string(p.proacl::text[],' | '),'DEFAULT')
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('lensed_approve_shift_pickup','lensed_cancel_shift_offer') order by 1;
