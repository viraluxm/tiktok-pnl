-- 056_fix_host_id_fk_to_employees.sql
--
-- Corrective migration. The live DB diverged from the repo: live_sessions.host_id
-- was created out-of-band with a FK to the empty `hosts` table, while the repo +
-- extension design (migration 050, which was NEVER applied to live) targets
-- employees(id). Symptoms: set_session_host is absent from pg_proc, idx_live_sessions_host
-- is absent, and the extension's host-attach RPC fails non-fatally so live_sessions.host_id
-- stays NULL on every session.
--
-- This migration reconciles the column to 050's intent: repoint the FK to
-- employees(id) ON DELETE SET NULL, add 050's missing index, and create
-- set_session_host (+ grant) verbatim from 050.
--
-- SAFETY:
--   * Single explicit transaction — a failure rolls back cleanly, so host_id is
--     NEVER left without a FK (no partial apply).
--   * Guarded + idempotent: the FK is discovered at RUNTIME (never a hardcoded
--     name); if it already targets employees the repoint is skipped.
--   * Does NOT drop the `hosts` table — retiring it is a separate decision.
--
-- PRE-FLIGHT (do NOT run mid-live): this takes a brief ACCESS EXCLUSIVE lock on
-- live_sessions to swap the constraint. Confirm no active show first:
--     SELECT count(*) FROM live_sessions WHERE status = 'live';   -- must be 0

begin;

do $$
declare
  v_conname text;
  v_target  text;
begin
  -- 1. VERIFY current state: find the FK backing live_sessions.host_id and its target table.
  select con.conname, tgt.relname
    into v_conname, v_target
  from pg_constraint con
  join pg_class src on src.oid = con.conrelid
  join pg_class tgt on tgt.oid = con.confrelid
  join pg_attribute a
    on a.attrelid = con.conrelid and a.attnum = any (con.conkey)
  where con.contype = 'f'
    and src.relname = 'live_sessions'
    and src.relnamespace = 'public'::regnamespace
    and a.attname = 'host_id';

  if v_conname is null then
    raise notice '[056] No existing FK on live_sessions.host_id — will add a fresh one to employees.';
  elsif v_target = 'employees' then
    raise notice '[056] FK % already references employees — repoint skipped (idempotent).', v_conname;
  else
    raise notice '[056] FK % currently references "%", dropping to repoint at employees.', v_conname, v_target;
    -- 2. Drop by the RUNTIME-discovered name, not a guess.
    execute format('alter table public.live_sessions drop constraint %I', v_conname);
    v_conname := null;  -- force the add below
  end if;

  -- 3. Add the employees FK (ON DELETE SET NULL) if it isn't already there.
  if not exists (
    select 1
    from pg_constraint con
    join pg_class src on src.oid = con.conrelid
    join pg_class tgt on tgt.oid = con.confrelid
    join pg_attribute a
      on a.attrelid = con.conrelid and a.attnum = any (con.conkey)
    where con.contype = 'f'
      and src.relname = 'live_sessions'
      and src.relnamespace = 'public'::regnamespace
      and a.attname = 'host_id'
      and tgt.relname = 'employees'
  ) then
    alter table public.live_sessions
      add constraint live_sessions_host_id_fkey
      foreign key (host_id) references public.employees(id) on delete set null;
    raise notice '[056] Added live_sessions_host_id_fkey -> employees(id) ON DELETE SET NULL.';
  end if;
end $$;

-- 4. The index 050 defined but that never landed.
create index if not exists idx_live_sessions_host on public.live_sessions(host_id);

-- 5. set_session_host — verbatim from 050. Attach / replace / clear the host on a
--    session the caller OWNS, validating the employee (when given) is also theirs.
--    p_host_id = NULL clears the attribution.
create or replace function public.set_session_host(p_session_id uuid, p_host_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_host_id is not null and not exists (
    select 1 from public.employees e
    where e.id = p_host_id and e.user_id = auth.uid()
  ) then
    raise exception 'HOST_NOT_FOUND_OR_NOT_OWNED';
  end if;

  update public.live_sessions
     set host_id = p_host_id, updated_at = now()
   where id = p_session_id and user_id = auth.uid();

  if not found then
    raise exception 'SESSION_NOT_FOUND_OR_NOT_OWNED';
  end if;
end;
$$;

grant execute on function public.set_session_host(uuid, uuid) to authenticated;

commit;
