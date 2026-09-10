-- Trade fixtures + refusal helper. Assumes ../schedule_phase2/harness.sql (t_eq, t_accept, t_reject,
-- t_report, mk, mkc) has already been applied.

-- One shift_trades row. Defaults produce a pending_manager (coworker-accepted) trade under owner A.
create or replace function mkt(p_req_emp uuid, p_req_shift uuid, p_tgt_emp uuid, p_tgt_shift uuid,
                               p_status text default 'pending_manager',
                               p_response text default 'accepted',
                               p_owner uuid default 'a0000000-0000-4000-8000-000000000001')
returns uuid language plpgsql as $$
declare v uuid;
begin
  insert into public.shift_trades(user_id, requester_employee_id, requester_shift_instance_id,
                                  target_employee_id, target_shift_instance_id, status,
                                  coworker_response, coworker_responded_at)
  values (p_owner, p_req_emp, p_req_shift, p_tgt_emp, p_tgt_shift, p_status,
          p_response, case when p_response is null then null else now() end)
  returning id into v;
  return v;
end $$;

-- Assert the RPC REFUSES with p_expect AND that neither shift, the trade, nor attendance moved.
create or replace function t_refuse_trade(p_label text, p_owner uuid, p_trade uuid, p_expect text)
returns void language plpgsql as $$
declare before_s jsonb; after_s jsonb; before_t public.shift_trades; after_t public.shift_trades;
        before_ev int; after_ev int; res jsonb;
begin
  select jsonb_agg(jsonb_build_object('id',id,'e',employee_id,'s',status,'src',source) order by id) into before_s
    from public.shift_instances;
  select * into before_t from public.shift_trades where id = p_trade;
  select count(*) into before_ev from public.attendance_events;

  res := public.lensed_approve_shift_trade(p_owner, p_trade, date '2026-09-07');

  select jsonb_agg(jsonb_build_object('id',id,'e',employee_id,'s',status,'src',source) order by id) into after_s
    from public.shift_instances;
  select * into after_t from public.shift_trades where id = p_trade;
  select count(*) into after_ev from public.attendance_events;

  if res->>'ok' <> 'false' then
    insert into t_results(label,ok,detail) values (p_label,false,'expected refusal, got '||res::text);
  elsif res->>'reason' <> p_expect then
    insert into t_results(label,ok,detail) values (p_label,false,'reason '||(res->>'reason')||' expected '||p_expect);
  elsif before_s is distinct from after_s then
    insert into t_results(label,ok,detail) values (p_label,false,'REFUSED BUT A SHIFT MUTATED');
  elsif before_t is distinct from after_t then
    insert into t_results(label,ok,detail) values (p_label,false,'REFUSED BUT THE TRADE MUTATED');
  elsif before_ev <> after_ev then
    insert into t_results(label,ok,detail) values (p_label,false,'REFUSED BUT ATTENDANCE WRITTEN');
  else
    insert into t_results(label,ok,detail) values (p_label,true,p_expect||' + no state change');
  end if;
end $$;
