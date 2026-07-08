-- 050_live_session_host.sql
-- Attribute a live session to a HOST (a person from the employees roster added in
-- 044_create_employees_and_shifts). This is the "extension host-stamping" that 044
-- explicitly deferred the show->host attribution link to.
--
-- Additive + nullable: pre-existing live_sessions rows get host_id = NULL. Both
-- employees and live_sessions are user_id-scoped (own-row RLS: auth.uid() = user_id),
-- so the FK stays within a single owner and needs no cross-org helper.
--
-- Host is attached out-of-band via set_session_host (below), NEVER via the session
-- INSERT — so session creation can't fail on this column and the extension degrades to
-- a no-op if this migration hasn't been applied yet.

alter table public.live_sessions
  add column if not exists host_id uuid references public.employees(id) on delete set null;

create index if not exists idx_live_sessions_host on public.live_sessions(host_id);

-- Attach / replace / clear the host on a session the caller OWNS, validating that the
-- employee (when given) is also the caller's. SECURITY DEFINER + fixed search_path
-- mirrors the app's other guarded RPCs; the explicit auth.uid() checks re-impose
-- ownership so the extension's ordinary authenticated JWT can only touch its own rows.
-- p_host_id = NULL clears the attribution.
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
