-- Migration 156's CHECKs and partial UNIQUEs. Every rejection names the rule that must fire, so a
-- row rejected by the WRONG constraint fails the test rather than passing by accident.
\set ON_ERROR_STOP on
set client_min_messages = notice;

set search_path = public;

-- NOTE: psql \set variables are NOT substituted inside dollar-quoted strings, so every id below
-- is written out in full. Kept as literals deliberately rather than as a helper, so a test that
-- names the wrong owner is visible on the line that names it.

-- ── shift_capacity_blocks ─────────────────────────────────────────────────────────────────────
select t_reject('block: team must be a known pay-role class',
  $$insert into shift_capacity_blocks(user_id,team,days_of_week,start_time,end_time)
    values ('a0000000-0000-4000-8000-000000000001','chef',array[1]::smallint[],'09:00','17:00')$$,
  'shift_capacity_blocks_team_check');

select t_reject('block: a weekday outside 0..6 is rejected',
  $$insert into shift_capacity_blocks(user_id,team,days_of_week,start_time,end_time)
    values ('a0000000-0000-4000-8000-000000000001','host',array[1,9]::smallint[],'09:00','17:00')$$,
  'shift_capacity_blocks_days_valid');

select t_reject('block: equal start and end is a zero-length block, not an overnight one',
  $$insert into shift_capacity_blocks(user_id,team,days_of_week,start_time,end_time)
    values ('a0000000-0000-4000-8000-000000000001','host',array[1]::smallint[],'09:00','09:00')$$,
  'shift_capacity_blocks_times_differ');

select t_reject('block: negative capacity is rejected',
  $$insert into shift_capacity_blocks(user_id,team,days_of_week,start_time,end_time,capacity)
    values ('a0000000-0000-4000-8000-000000000001','host',array[1]::smallint[],'09:00','17:00',-1)$$,
  'shift_capacity_blocks_capacity_nonneg');

select t_accept('block: capacity 0 is legal (a block that advertises nothing)',
  $$insert into shift_capacity_blocks(id,user_id,team,days_of_week,start_time,end_time,capacity)
    values ('bf000000-0000-4000-8000-0000000000ff','a0000000-0000-4000-8000-000000000001','host',array[1]::smallint[],'09:00','17:00',0)$$);

select t_accept('block: an OVERNIGHT block (end <= start) is legal',
  $$insert into shift_capacity_blocks(id,user_id,team,days_of_week,start_time,end_time)
    values ('bf000000-0000-4000-8000-0000000000fe','a0000000-0000-4000-8000-000000000001','host',array[1]::smallint[],'22:00','06:00')$$);

-- ── shift_capacity_settings — exactly TWO shapes ──────────────────────────────────────────────
select t_reject('settings: a block with no date is not a legal scope',
  $$insert into shift_capacity_settings(user_id,team,block_id,date,capacity)
    values ('a0000000-0000-4000-8000-000000000001','host','b1000000-0000-4000-8000-000000000001',null,5)$$,
  'shift_capacity_settings_shape');

select t_reject('settings: a date with no block is not a legal scope',
  $$insert into shift_capacity_settings(user_id,team,block_id,date,capacity)
    values ('a0000000-0000-4000-8000-000000000001','host',null,date '2026-09-16',5)$$,
  'shift_capacity_settings_shape');

select t_reject('settings: a team default that sets nothing has no meaning',
  $$insert into shift_capacity_settings(user_id,team,block_id,date,capacity,closed)
    values ('a0000000-0000-4000-8000-000000000001','fulfillment',null,null,null,false)$$,
  'shift_capacity_settings_team_default_is_meaningful');

select t_reject('settings: only ONE team default per (owner, team)',
  $$insert into shift_capacity_settings(user_id,team,block_id,date,capacity)
    values ('a0000000-0000-4000-8000-000000000001','host',null,null,7)$$,
  'idx_shift_capacity_settings_team_default');

select t_accept('settings: a date override for one block is legal',
  $$insert into shift_capacity_settings(id,user_id,team,block_id,date,capacity)
    values ('cf000000-0000-4000-8000-0000000000f1','a0000000-0000-4000-8000-000000000001','host','b1000000-0000-4000-8000-000000000001',date '2026-09-16',2)$$);

select t_reject('settings: only ONE override per (block, date)',
  $$insert into shift_capacity_settings(user_id,team,block_id,date,capacity)
    values ('a0000000-0000-4000-8000-000000000001','host','b1000000-0000-4000-8000-000000000001',date '2026-09-16',9)$$,
  'idx_shift_capacity_settings_block_date');

select t_accept('settings: a CLOSED override needs no capacity',
  $$insert into shift_capacity_settings(id,user_id,team,block_id,date,closed)
    values ('cf000000-0000-4000-8000-0000000000f2','a0000000-0000-4000-8000-000000000001','host','b1000000-0000-4000-8000-000000000001',date '2026-09-17',true)$$);

-- ── shift_requests ────────────────────────────────────────────────────────────────────────────
select t_reject('request: an unknown status is rejected',
  $$insert into shift_requests(user_id,employee_id,block_id,shift_date,starts_at,ends_at,team,status)
    values ('a0000000-0000-4000-8000-000000000001','e1111111-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',date '2026-10-01','2026-10-02 01:00Z','2026-10-02 09:00Z','host','maybe')$$,
  'shift_requests_status_check');

select t_reject('request: a reversed span is rejected',
  $$insert into shift_requests(user_id,employee_id,block_id,shift_date,starts_at,ends_at,team)
    values ('a0000000-0000-4000-8000-000000000001','e1111111-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',date '2026-10-01','2026-10-02 09:00Z','2026-10-02 01:00Z','host')$$,
  'shift_requests_span_ordered');

select t_reject('request: approved WITHOUT a shift is impossible — approval means a shift exists',
  $$insert into shift_requests(user_id,employee_id,block_id,shift_date,starts_at,ends_at,team,status)
    values ('a0000000-0000-4000-8000-000000000001','e1111111-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',date '2026-10-01','2026-10-02 01:00Z','2026-10-02 09:00Z','host','approved')$$,
  'shift_requests_approved_has_instance');

select t_accept('request: a pending request is legal',
  $$insert into shift_requests(id,user_id,employee_id,block_id,shift_date,starts_at,ends_at,team)
    values ('df000000-0000-4000-8000-0000000000f1','a0000000-0000-4000-8000-000000000001','e1111111-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',date '2026-10-01','2026-10-02 01:00Z','2026-10-02 09:00Z','host')$$);

select t_reject('request: THE DOUBLE-TAP GUARD — one pending request per person per day',
  $$insert into shift_requests(user_id,employee_id,block_id,shift_date,starts_at,ends_at,team)
    values ('a0000000-0000-4000-8000-000000000001','e1111111-0000-4000-8000-000000000001','b2000000-0000-4000-8000-000000000002',date '2026-10-01','2026-10-01 13:00Z','2026-10-01 21:00Z','host')$$,
  'idx_shift_requests_one_pending_per_day');

select t_accept('request: a DIFFERENT person may request the same day',
  $$insert into shift_requests(id,user_id,employee_id,block_id,shift_date,starts_at,ends_at,team)
    values ('df000000-0000-4000-8000-0000000000f2','a0000000-0000-4000-8000-000000000001','e2222222-0000-4000-8000-000000000002','b1000000-0000-4000-8000-000000000001',date '2026-10-01','2026-10-02 01:00Z','2026-10-02 09:00Z','host')$$);

update shift_requests set status='withdrawn' where id='df000000-0000-4000-8000-0000000000f1';
select t_accept('request: a WITHDRAWN request frees the day to be re-requested',
  $$insert into shift_requests(id,user_id,employee_id,block_id,shift_date,starts_at,ends_at,team)
    values ('df000000-0000-4000-8000-0000000000f3','a0000000-0000-4000-8000-000000000001','e1111111-0000-4000-8000-000000000001','b1000000-0000-4000-8000-000000000001',date '2026-10-01','2026-10-02 01:00Z','2026-10-02 09:00Z','host')$$);

-- Clean up the constraint fixtures so the RPC suite starts from the seeded world.
delete from shift_requests where id in ('df000000-0000-4000-8000-0000000000f1','df000000-0000-4000-8000-0000000000f2','df000000-0000-4000-8000-0000000000f3');
delete from shift_capacity_settings where id in ('cf000000-0000-4000-8000-0000000000f1','cf000000-0000-4000-8000-0000000000f2');
delete from shift_capacity_blocks where id in ('bf000000-0000-4000-8000-0000000000ff','bf000000-0000-4000-8000-0000000000fe');

select t_report('156 CONSTRAINTS');
