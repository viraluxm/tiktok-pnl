-- Capacity-specific assertion helpers, layered on ../schedule_phase2/harness.sql.

-- A staffing block's window on a date, computed the SAME way the RPC computes it. Used by the
-- fixture builder so a seeded shift is deliberately inside or outside a block.
create or replace function blk_span(p_block uuid, p_date date, out starts_at timestamptz, out ends_at timestamptz)
language plpgsql as $$
declare b public.shift_capacity_blocks;
begin
  select * into b from public.shift_capacity_blocks where id = p_block;
  starts_at := (p_date + b.start_time) at time zone 'America/Los_Angeles';
  ends_at := ((case when b.end_time <= b.start_time then p_date + 1 else p_date end) + b.end_time)
             at time zone 'America/Los_Angeles';
end $$;

-- One shift_instance whose span is an LA wall-clock range on p_date (end<=start rolls a day).
create or replace function mkspan(p_emp uuid, p_date date, p_start time, p_end time,
                                  p_status text default 'scheduled',
                                  p_state text default null, p_oid uuid default null,
                                  p_owner uuid default 'a0000000-0000-4000-8000-000000000001')
returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.shift_instances(user_id, employee_id, shift_date, starts_at, ends_at, status,
                                     offer_state, offer_id, offered_at)
  values (p_owner, p_emp, p_date,
          (p_date + p_start) at time zone 'America/Los_Angeles',
          ((case when p_end <= p_start then p_date + 1 else p_date end) + p_end) at time zone 'America/Los_Angeles',
          p_status, p_state, p_oid, case when p_state is null then null else now() end)
  returning id into v;
  return v;
end $$;

-- One pending shift_request whose span matches its block on that date (what the app writes).
create or replace function mkreq(p_emp uuid, p_block uuid, p_date date,
                                 p_owner uuid default 'a0000000-0000-4000-8000-000000000001')
returns uuid language plpgsql as $$
declare v uuid; s timestamptz; e timestamptz; t text;
begin
  select starts_at, ends_at into s, e from blk_span(p_block, p_date);
  select team into t from public.shift_capacity_blocks where id = p_block;
  insert into public.shift_requests(user_id, employee_id, block_id, shift_date, starts_at, ends_at, team, status)
  values (p_owner, p_emp, p_block, p_date, s, e, t, 'pending') returning id into v;
  return v;
end $$;

-- Assert the RPC REFUSES with p_expect, AND that it wrote NOTHING. The non-mutation half is the
-- point: a refusal that created a shift_instance, or moved the request, is a torn state.
create or replace function t_refuse_req(p_label text, p_owner uuid, p_request uuid,
                                        p_expect text)
returns void language plpgsql as $$
declare before_r public.shift_requests; after_r public.shift_requests;
        n_before int; n_after int; res jsonb;
begin
  select * into before_r from public.shift_requests where id = p_request;
  select count(*) into n_before from public.shift_instances;
  res := public.lensed_approve_shift_request(p_owner, p_request);
  select * into after_r from public.shift_requests where id = p_request;
  select count(*) into n_after from public.shift_instances;

  if res->>'ok' <> 'false' then
    insert into t_results(label,ok,detail) values (p_label,false,'expected refusal, got '||res::text);
  elsif res->>'reason' <> p_expect then
    insert into t_results(label,ok,detail) values (p_label,false,'reason '||(res->>'reason')||' expected '||p_expect);
  elsif before_r is distinct from after_r then
    insert into t_results(label,ok,detail) values (p_label,false,'REFUSED BUT THE REQUEST MUTATED');
  elsif n_before <> n_after then
    insert into t_results(label,ok,detail) values (p_label,false,'REFUSED BUT CREATED A SHIFT ('||n_before||'→'||n_after||')');
  else
    insert into t_results(label,ok,detail) values (p_label,true,p_expect||' + nothing written');
  end if;
end $$;

-- The staffed count for a block on a date, using the SAME predicate as the RPC. Lets a test assert
-- the number the employee would have been shown.
create or replace function staffed_in(p_owner uuid, p_block uuid, p_date date) returns int
language plpgsql as $$
declare s timestamptz; e timestamptz; t text; n int;
begin
  select starts_at, ends_at into s, e from blk_span(p_block, p_date);
  select team into t from public.shift_capacity_blocks where id = p_block;
  select count(*) into n
    from public.shift_instances si join public.employees emp on emp.id = si.employee_id
   where si.user_id = p_owner and emp.user_id = p_owner
     and si.employee_id is not null and si.status in ('scheduled','claimed')
     and si.starts_at < e and si.ends_at > s
     and (case when lower(btrim(coalesce(emp.role,''))) in ('host','live host') then 'host'
               when lower(btrim(coalesce(emp.role,''))) = 'fulfillment' then 'fulfillment'
               else 'other' end) = t;
  return n;
end $$;
