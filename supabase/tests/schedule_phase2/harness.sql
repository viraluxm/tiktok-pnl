-- Assertion helpers + fixture builders shared by every test_*.sql in this directory.
--
-- WHY t_reject TAKES AN EXPECTED RULE NAME: asserting only "this failed" is nearly worthless for
-- a constraint suite — a row can be rejected by the WRONG constraint (or a typo'd column) and the
-- test would still pass. Every rejection here names the rule that must have fired.

create table if not exists t_results(seq serial, label text, ok boolean, detail text);

-- The statement must succeed.
create or replace function t_accept(p_label text, p_sql text) returns void language plpgsql as $$
begin
  begin
    execute p_sql;
    insert into t_results(label, ok, detail) values (p_label, true, 'accepted');
  exception when others then
    insert into t_results(label, ok, detail) values (p_label, false, 'REJECTED: '||SQLERRM);
  end;
end $$;

-- The statement must fail, and fail BY THE NAMED RULE. p_expect is matched against the
-- constraint/index name when the error carries one, else against the message text.
create or replace function t_reject(p_label text, p_sql text, p_expect text) returns void
language plpgsql as $$
declare v_con text; v_msg text;
begin
  begin
    execute p_sql;
    insert into t_results(label, ok, detail) values (p_label, false, 'ACCEPTED but should have been rejected');
    return;
  exception when others then
    get stacked diagnostics v_con = CONSTRAINT_NAME, v_msg = MESSAGE_TEXT;
  end;
  if coalesce(v_con,'') = p_expect or v_msg like '%'||p_expect||'%' then
    insert into t_results(label, ok, detail) values (p_label, true, 'rejected by '||coalesce(nullif(v_con,''), v_msg));
  else
    insert into t_results(label, ok, detail) values (p_label, false,
      'rejected by WRONG rule: con='||coalesce(v_con,'-')||' msg='||v_msg||' (expected '||p_expect||')');
  end if;
end $$;

create or replace function t_eq(p_label text, p_actual anyelement, p_expected anyelement) returns void
language plpgsql as $$
begin
  if p_actual is not distinct from p_expected then
    insert into t_results(label, ok, detail) values (p_label, true, 'got '||coalesce(p_actual::text,'NULL'));
  else
    insert into t_results(label, ok, detail) values (p_label, false,
      'got '||coalesce(p_actual::text,'NULL')||' expected '||coalesce(p_expected::text,'NULL'));
  end if;
end $$;

-- Prints every assertion, then RAISES if any failed so psql -v ON_ERROR_STOP=1 exits non-zero.
create or replace function t_report(p_section text) returns void language plpgsql as $$
declare r record; n_pass int; n_fail int;
begin
  for r in select label, ok, detail from t_results order by seq loop
    raise notice '%  %  — %', case when r.ok then 'PASS' else 'FAIL' end, rpad(r.label, 58), r.detail;
  end loop;
  select count(*) filter (where ok), count(*) filter (where not ok) into n_pass, n_fail from t_results;
  raise notice '';
  raise notice '%: % passed, % FAILED', p_section, n_pass, n_fail;
  delete from t_results;
  if n_fail > 0 then raise exception 'SECTION FAILED: % (% failures)', p_section, n_fail; end if;
end $$;

-- ── fixture builders ───────────────────────────────────────────────────────────────────────────
-- One shift_instance. Defaults produce the ordinary not-offered row.
create or replace function mk(p_emp uuid, p_date date, p_status text default 'scheduled',
                              p_state text default null, p_oid uuid default null,
                              p_oat timestamptz default null, p_rel timestamptz default null,
                              p_owner uuid default 'a0000000-0000-4000-8000-000000000001')
returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.shift_instances(user_id, employee_id, shift_date, starts_at, ends_at, status,
                                     released_at, offer_state, offer_id, offered_at)
  values (p_owner, p_emp, p_date, p_date + time '09:00', p_date + time '17:00', p_status,
          p_rel, p_state, p_oid, p_oat)
  returning id into v;
  return v;
end $$;

-- One shift_claim. Defaults to the LEGACY ot_claim shape.
create or replace function mkc(p_inst uuid, p_emp uuid, p_status text, p_kind text default 'ot_claim',
                               p_oid uuid default null,
                               p_owner uuid default 'a0000000-0000-4000-8000-000000000001')
returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.shift_claims(user_id, shift_instance_id, claimed_by, status, kind, offer_id)
  values (p_owner, p_inst, p_emp, p_status, p_kind, p_oid) returning id into v;
  return v;
end $$;

-- Assert the RPC REFUSES with p_expect AND that neither the instance nor its claims moved.
-- The "no state change" half is the point: a refusal that mutated anything is a torn state.
create or replace function t_refuse(p_label text, p_owner uuid, p_shift uuid, p_claim uuid,
                                    p_oid uuid, p_expect text) returns void language plpgsql as $$
declare before_i public.shift_instances; after_i public.shift_instances;
        before_c jsonb; after_c jsonb; res jsonb;
begin
  select * into before_i from public.shift_instances where id = p_shift;
  select jsonb_agg(jsonb_build_object('id',id,'s',status) order by id) into before_c
    from public.shift_claims where shift_instance_id = p_shift;
  -- Fixed pay period: these assertions are about refusal + non-mutation, not about which period a
  -- (never-written) attendance row would land in.
  res := public.lensed_approve_shift_pickup(p_owner, p_shift, p_claim, p_oid, date '2026-09-07');
  select * into after_i from public.shift_instances where id = p_shift;
  select jsonb_agg(jsonb_build_object('id',id,'s',status) order by id) into after_c
    from public.shift_claims where shift_instance_id = p_shift;

  if res->>'ok' <> 'false' then
    insert into t_results(label,ok,detail) values (p_label,false,'expected refusal, got '||res::text);
  elsif res->>'reason' <> p_expect then
    insert into t_results(label,ok,detail) values (p_label,false,'reason '||(res->>'reason')||' expected '||p_expect);
  elsif before_i is distinct from after_i then
    insert into t_results(label,ok,detail) values (p_label,false,'REFUSED BUT INSTANCE MUTATED');
  elsif before_c is distinct from after_c then
    insert into t_results(label,ok,detail) values (p_label,false,'REFUSED BUT CLAIMS MUTATED');
  else
    insert into t_results(label,ok,detail) values (p_label,true,p_expect||' + no state change');
  end if;
end $$;
