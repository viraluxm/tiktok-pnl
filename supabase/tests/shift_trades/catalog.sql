-- Stable, diffable projection of everything migration 136 touches.
\pset format unaligned
\pset tuples_only on
select 'COL '||table_name||'.'||column_name||' '||data_type||' null='||is_nullable||' def='||coalesce(column_default,'-')
  from information_schema.columns where table_schema='public' and table_name='shift_trades' order by column_name;
select 'CON '||conrelid::regclass||' '||conname||' '||pg_get_constraintdef(oid)
  from pg_constraint where conrelid = to_regclass('public.shift_trades') order by conname;
select 'IDX '||indexdef from pg_indexes where schemaname='public' and tablename='shift_trades' order by indexname;
select 'POL '||policyname||' '||cmd||' '||coalesce(qual,'-') from pg_policies where schemaname='public' and tablename='shift_trades' order by policyname;
select 'FN  '||p.oid::regprocedure||' sec='||case when p.prosecdef then 'definer' else 'invoker' end
       ||' cfg='||coalesce(array_to_string(p.proconfig,','),'-')
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname='lensed_approve_shift_trade' order by 1;
select 'ACL '||p.oid::regprocedure||' '||coalesce(array_to_string(p.proacl::text[],' | '),'DEFAULT')
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname='lensed_approve_shift_trade' order by 1;
-- The pre-existing tables 136 must NOT touch.
select 'PRE '||conrelid::regclass||' '||conname from pg_constraint
 where conrelid in ('public.shift_instances'::regclass,'public.shift_claims'::regclass,'public.attendance_events'::regclass) order by 1;
