-- Stable, diffable projection of everything migration 156 touches.
\pset format unaligned
\pset tuples_only on
select 'COL '||table_name||'.'||column_name||' '||data_type||' null='||is_nullable||' def='||coalesce(column_default,'-')
  from information_schema.columns
 where table_schema='public' and table_name in ('shift_capacity_blocks','shift_capacity_settings','shift_requests')
 order by table_name, column_name;
select 'CON '||conrelid::regclass||' '||conname||' '||pg_get_constraintdef(oid)
  from pg_constraint
 where conrelid in (to_regclass('public.shift_capacity_blocks'), to_regclass('public.shift_capacity_settings'), to_regclass('public.shift_requests'))
 order by conrelid::regclass::text, conname;
select 'IDX '||indexdef from pg_indexes
 where schemaname='public' and tablename in ('shift_capacity_blocks','shift_capacity_settings','shift_requests','shift_instances')
 order by indexname;
select 'RLS '||relname||' '||relrowsecurity from pg_class
 where relnamespace='public'::regnamespace and relname in ('shift_capacity_blocks','shift_capacity_settings','shift_requests') order by relname;
select 'POL '||tablename||' '||policyname||' '||cmd||' '||coalesce(qual,'-') from pg_policies
 where schemaname='public' and tablename in ('shift_capacity_blocks','shift_capacity_settings','shift_requests') order by tablename, policyname;
select 'FN  '||p.oid::regprocedure||' sec='||case when p.prosecdef then 'definer' else 'invoker' end
       ||' cfg='||coalesce(array_to_string(p.proconfig,','),'-')
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public'
   and p.proname in ('lensed_approve_shift_request','lensed_apply_schedule_batch','lensed_assign_released_shift')
 order by 1;
select 'ACL '||p.oid::regprocedure||' '||coalesce(array_to_string(p.proacl::text[],' | '),'DEFAULT')
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public'
   and p.proname in ('lensed_approve_shift_request','lensed_apply_schedule_batch','lensed_assign_released_shift')
 order by 1;
-- THE PRE-EXISTING TABLES 156 MUST NOT NARROW. A removed line here is a regression in the
-- shipped scheduling system, which is the whole reason this projection is diffed before/after.
select 'PRE '||conrelid::regclass||' '||conname from pg_constraint
 where conrelid in ('public.shift_instances'::regclass,'public.shift_claims'::regclass,'public.attendance_events'::regclass,'public.shift_rules'::regclass)
 order by 1;
select 'PREIDX '||indexname from pg_indexes
 where schemaname='public' and tablename in ('shift_claims','attendance_events','shift_rules') order by indexname;
