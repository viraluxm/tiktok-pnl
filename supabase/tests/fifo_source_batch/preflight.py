#!/usr/bin/env python3
"""RELEASE PREFLIGHT for migrations 152 -> 153 -> 154.

Not the behavioural suite (that is run.sh). This answers the release questions:

  * does the stack apply cleanly in production order, and is each file idempotent?
  * does merely APPLYING it change any existing row?  (checksums before/after)
  * is the resulting privilege matrix right for authenticated / anon / service_role?
  * does the cost-write guard hold against a DIRECT table UPDATE performed by a real,
    non-superuser `authenticated` role with RLS enforced — i.e. the PostgREST path?

Written in Python rather than bash because it captures a dozen query results and compares
them; shell quoting around psql heredocs made that unreliable.

Read-only with respect to production: everything happens in a throwaway container.

  python3 supabase/tests/fifo_source_batch/preflight.py
"""
import os, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
MIGS = os.path.normpath(os.path.join(HERE, '..', '..', 'migrations'))
CONTAINER = f'lensed_preflight_{os.getpid()}'
DB = 'db_preflight'
A = '11111111-1111-1111-1111-111111111111'
ORG1 = '22222222-2222-2222-2222-222222222222'

failures = []
def ok(msg):  print(f'  ✓ {msg}')
def bad(msg): print(f'  ✗ {msg}'); failures.append(msg)
def hdr(msg): print(f'\n══ {msg} ══')

def sh(args, **kw):
    return subprocess.run(args, capture_output=True, text=True, **kw)

def psql(sql, stop=True, role=None, user_id=None):
    """Run SQL in the container. role/user_id reproduce a PostgREST request."""
    pre = ''
    if user_id: pre += f"select set_config('test.user_id', '{user_id}', false);\n"
    if role:    pre += f'set role {role};\n'
    args = ['docker','exec','-i',CONTAINER,'psql','-U','postgres','-d',DB]
    if stop: args += ['-v','ON_ERROR_STOP=1']
    return sh(args, input=pre+sql)

def q(sql):
    """Single-row query -> list of column strings."""
    r = sh(['docker','exec','-i',CONTAINER,'psql','-U','postgres','-d',DB,'-tA','-c',sql])
    if r.returncode != 0:
        bad(f'query failed: {r.stderr.strip().splitlines()[:1]}'); return []
    line = r.stdout.strip().split('\n')[0]
    return line.split('|') if line else []

def apply_file(path, label):
    r = sh(['docker','exec','-i',CONTAINER,'psql','-U','postgres','-d',DB,'-v','ON_ERROR_STOP=1','-1'],
           input=open(path).read())
    return r.returncode == 0, r.stderr

def main():
    print(f'▶ starting postgres:16-alpine as {CONTAINER} ...')
    sh(['docker','rm','-f',CONTAINER])
    sh(['docker','run','-d','--name',CONTAINER,'-e','POSTGRES_PASSWORD=postgres','postgres:16-alpine'])
    # pg_isready is not enough: initdb runs a temporary server first. Require two real queries.
    ready = 0
    for _ in range(90):
        if sh(['docker','exec',CONTAINER,'psql','-U','postgres','-d','postgres','-tAc','select 1']).returncode == 0:
            ready += 1
            if ready >= 2: break
        else: ready = 0
        time.sleep(1)
    if ready < 2: print('✗ postgres never became ready'); return 1
    sh(['docker','exec',CONTAINER,'createdb','-U','postgres',DB])
    print('  ready')

    hdr('1. BASELINE: the pre-feature production starting point')
    for f, label in [(os.path.join(HERE,'bootstrap.sql'),'bootstrap'),
                     (os.path.join(MIGS,'083_fifo_batch_edit_delete.sql'),'083'),
                     (os.path.join(MIGS,'105_bind_records_short_at_bind.sql'),'105'),
                     (os.path.join(MIGS,'103_platform_fee_centralization.sql'),'103'),
                     (os.path.join(HERE,'pnl_order_grain.prodview.sql'),'pnl_order_grain')]:
        good, err = apply_file(f, label)
        if not good: bad(f'baseline {label} failed: {err.strip().splitlines()[:2]}')
    ok('baseline applied (bootstrap + 083 + 105 + 103 + pnl_order_grain)')

    hdr('2. REPRESENTATIVE LEGACY DATA (written by the PRE-feature RPCs)')
    r = psql(open(os.path.join(HERE,'seed_legacy.sql')).read())
    if r.returncode != 0: bad(f'legacy seed: {r.stderr.strip().splitlines()[:2]}')
    pop = """
do $$
declare s uuid; b uuid; sess uuid; i int; c int;
begin
  insert into public.live_sessions (user_id, status, title, started_at)
    values ('%(A)s','live','preflight', now()) returning id into sess;
  for i in 1..8 loop
    c := case when i %% 4 = 0 then null when i %% 4 = 1 then 0 else i * 100 end;
    insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
      values ('%(A)s','%(ORG)s', 500+i, 'PF'||i, 'Preflight '||i, c, 0) returning id into s;
    insert into public.sku_batches (user_id, org_id, sku_id, qty_remaining, qty_added, unit_cost_cents, sequence)
      values ('%(A)s','%(ORG)s', s, 50, null, c, 1) returning id into b;
    update public.inventory_skus set qty_on_hand = 50 where id = s;
    perform * from public.lensed_log_auction(sess,'sold',
      jsonb_build_array(jsonb_build_object('sku_id', s, 'qty', 3)), 'pf-'||i, false, false);
    insert into public.capture_events (user_id, order_id, selling_price_cents, ordered_at)
      values ('%(A)s','pf-'||i, 5000, now());
  end loop;
end $$;""" % {'A':A,'ORG':ORG1}
    r = psql(pop, user_id=A)
    if r.returncode != 0: bad(f'legacy population: {r.stderr.strip().splitlines()[:3]}')

    SNAP = """select
   (select count(*) from public.sku_batches),
   (select count(*) from public.live_auction_item_skus),
   (select count(*) from public.inventory_skus),
   (select coalesce(sum(qty_remaining),0) from public.sku_batches),
   (select coalesce(sum(qty_on_hand),0) from public.inventory_skus),
   (select md5(coalesce(string_agg(l.id::text||':'||coalesce(l.unit_cost_cents_snapshot::text,'~')||':'||l.qty::text, ',' order by l.id),''))
      from public.live_auction_item_skus l),
   (select md5(coalesce(string_agg(b.id::text||':'||coalesce(b.unit_cost_cents::text,'~')||':'||b.qty_remaining::text||':'||coalesce(b.qty_added::text,'~'), ',' order by b.id),''))
      from public.sku_batches b),
   (select md5(coalesce(string_agg(s.id::text||':'||coalesce(s.unit_cost_cents::text,'~')||':'||s.qty_on_hand::text, ',' order by s.id),''))
      from public.inventory_skus s)"""
    before = q(SNAP)
    if len(before) != 8: bad(f'baseline snapshot returned {len(before)} columns'); return 1
    bB, bL, bS, bRem, bQoh, bLH, bBH, bSH = before
    print(f'  batches={bB}  sale_lines={bL}  skus={bS}  Σqty_remaining={bRem}  Σqty_on_hand={bQoh}')
    print(f'  checksums  lines={bLH[:12]}  batches={bBH[:12]}  skus={bSH[:12]}')
    if int(bL) == 0: bad('VACUOUS baseline — no sale lines to protect')

    hdr('3. APPLY IN PRODUCTION ORDER')
    order = ['152_fifo_batch_cost_state_and_attribution',
             '153_fifo_record_source_batch',
             '154_fifo_finalize_batch_cost']
    for m in order:
        good, err = apply_file(os.path.join(MIGS, m+'.sql'), m)
        ok(f'applied {m}') if good else bad(f'FAILED to apply {m}: {err.strip().splitlines()[:4]}')
    for m in order:
        good, err = apply_file(os.path.join(MIGS, m+'.sql'), m)
        ok(f're-apply is a no-op: {m}') if good else bad(f'NOT idempotent: {m}: {err.strip().splitlines()[:3]}')

    hdr('3b. ATOMICITY — can all three apply as ONE transaction?')
    # This matters: if 152 lands without 153, every batch created in the gap takes the column
    # DEFAULTS (cost_status 'legacy', qty_added_authoritative false). Nothing ever flips that
    # flag afterwards, so those batches become permanently non-finalizable even though, once
    # 153 lands, their sales DO carry source_batch_id. Applying the three inside a single
    # transaction makes that window unobservable. Every statement in all three is
    # transactional (no CREATE INDEX CONCURRENTLY, no ALTER TYPE ... ADD VALUE), so this
    # should succeed — proving it here is what lets the runbook require it.
    combined = 'begin;\n' + '\n'.join(
        open(os.path.join(MIGS, m + '.sql')).read() for m in order) + '\ncommit;\n'
    r = sh(['docker','exec','-i',CONTAINER,'psql','-U','postgres','-d',DB,'-v','ON_ERROR_STOP=1'],
           input=combined)
    ok('all three apply inside ONE explicit transaction — States A and B need never be observable') \
        if r.returncode == 0 else bad(f'single-transaction apply failed: {r.stderr.strip().splitlines()[:4]}')

    hdr('4. DATA PRESERVATION — did merely APPLYING change anything?')
    after = q(SNAP)
    if len(after) != 8: bad('post-apply snapshot failed'); return 1
    aB, aL, aS, aRem, aQoh, aLH, aBH, aSH = after
    (ok if bB==aB else bad)(f'batch count unchanged ({aB})' if bB==aB else f'batch count {bB} -> {aB}')
    (ok if bL==aL else bad)(f'sale-line count unchanged ({aL})' if bL==aL else f'sale-line count {bL} -> {aL}')
    (ok if bRem==aRem else bad)(f'Σqty_remaining unchanged ({aRem})' if bRem==aRem else f'Σqty_remaining {bRem} -> {aRem}')
    (ok if bQoh==aQoh else bad)(f'Σqty_on_hand unchanged ({aQoh})' if bQoh==aQoh else f'Σqty_on_hand {bQoh} -> {aQoh}')
    (ok if bLH==aLH else bad)('sale-line checksum IDENTICAL — no historical COGS snapshot rewritten' if bLH==aLH else 'SALE-LINE CHECKSUM CHANGED')
    (ok if bBH==aBH else bad)('batch checksum IDENTICAL — no cost or quantity rewritten' if bBH==aBH else 'BATCH CHECKSUM CHANGED')
    (ok if bSH==aSH else bad)('inventory_skus checksum IDENTICAL — no on-hand or cost scalar moved' if bSH==aSH else 'SKU CHECKSUM CHANGED')
    extra = q("""select (select count(*) from public.live_auction_item_skus where source_batch_id is not null),
                        (select count(*) from public.sku_batches where cost_status <> 'legacy'),
                        (select count(*) from public.sku_batches where qty_added_authoritative),
                        (select count(*) from public.sku_batch_cost_revisions)""")
    if len(extra) == 4:
        a1,a2,a3,a4 = extra
        (ok if a1=='0' else bad)(f'all {aL} legacy sale lines remain honestly unattributed' if a1=='0' else f'{a1} legacy rows back-filled')
        (ok if a2=='0' else bad)("every pre-existing batch classified 'legacy' (none falsely finalized)" if a2=='0' else f'{a2} not legacy')
        (ok if a3=='0' else bad)('no pre-existing batch claims an authoritative qty_added' if a3=='0' else f'{a3} marked authoritative')
        (ok if a4=='0' else bad)('audit table created empty — applying records no revisions' if a4=='0' else f'{a4} revisions appeared')

    hdr('5. CATALOG')
    r = psql("""do $$
declare v int; v_rule text;
begin
  select count(*) into v from information_schema.columns where table_schema='public'
    and (table_name,column_name) in (('sku_batches','cost_status'),('sku_batches','qty_added_authoritative'),
                                     ('live_auction_item_skus','source_batch_id'));
  if v <> 3 then raise exception 'expected 3 new columns, found %', v; end if;
  select count(*) into v from pg_constraint where conrelid='public.sku_batches'::regclass
    and conname in ('sku_batches_cost_status_chk','sku_batches_qty_added_authoritative_chk') and convalidated;
  if v <> 2 then raise exception '2 VALIDATED checks expected, found %', v; end if;
  if not exists (select 1 from pg_constraint where conname='live_auction_item_skus_source_batch_id_fkey' and convalidated)
    then raise exception 'FK missing or NOT VALIDATED'; end if;
  select rc.delete_rule into v_rule from information_schema.referential_constraints rc
    where rc.constraint_name='live_auction_item_skus_source_batch_id_fkey';
  if v_rule <> 'NO ACTION' then raise exception 'FK delete_rule is %', v_rule; end if;
  if not exists (select 1 from pg_indexes where schemaname='public'
                  and indexname='idx_live_auction_item_skus_source_batch') then raise exception 'partial index missing'; end if;
  if not exists (select 1 from pg_trigger where tgrelid='public.sku_batches'::regclass
                  and tgname='sku_batches_guard_cost_write' and not tgisinternal) then raise exception 'guard trigger missing'; end if;
  if not (select relrowsecurity from pg_class where oid='public.sku_batch_cost_revisions'::regclass)
    then raise exception 'audit RLS not enabled'; end if;
  select count(*) into v from pg_policies where schemaname='public' and tablename='sku_batch_cost_revisions';
  if v <> 2 then raise exception 'audit table should have exactly 2 policies, found %', v; end if;
end $$;""")
    ok('3 columns, 2 validated CHECKs, validated FK (NO ACTION), partial index, guard trigger, audit RLS + 2 append-only policies') \
        if r.returncode == 0 else bad(f'catalog: {r.stderr.strip().splitlines()[:2]}')

    hdr('6. PRIVILEGE MATRIX')
    sigs = ['public.lensed_finalize_batch_cost(uuid,uuid,int)',
            'public.lensed_add_batch(uuid,int,int)',
            'public.lensed_edit_batch(uuid,uuid,int,int,boolean)',
            'public.lensed_delete_batch(uuid,uuid)',
            'public.lensed_settle_batch(uuid)',
            'public.lensed_log_auction(uuid,text,jsonb,text,boolean,boolean)',
            'public.lensed_unbind(text)',
            'public.lensed_add_batch_admin(uuid,uuid,int,int,text,uuid)',
            'public.lensed_log_auction_as(uuid,uuid,text,jsonb,text,boolean,boolean)',
            'public.lensed_unbind_as(uuid,text)',
            'public.lensed_void_batch(uuid,uuid)']
    print(f"  {'function':58s} {'auth':6s} {'anon':6s} {'service':7s}")
    for s in sigs:
        row = q(f"select has_function_privilege('authenticated','{s}','EXECUTE')::text,"
                f"       has_function_privilege('anon','{s}','EXECUTE')::text,"
                f"       has_function_privilege('service_role','{s}','EXECUTE')::text")
        if len(row)==3:
            print(f"  {s.replace('public.',''):58s} {row[0]:6s} {row[1]:6s} {row[2]:7s}")
    r = psql("""do $$ begin
  if not has_function_privilege('authenticated','public.lensed_finalize_batch_cost(uuid,uuid,int)','EXECUTE')
    then raise exception 'authenticated cannot call the finalize RPC'; end if;
  if has_function_privilege('anon','public.lensed_finalize_batch_cost(uuid,uuid,int)','EXECUTE')
    then raise exception 'anon CAN call the finalize RPC — new anon write exposure'; end if;
  if not has_function_privilege('service_role','public.lensed_finalize_batch_cost(uuid,uuid,int)','EXECUTE')
    then raise exception 'service_role lost EXECUTE on the finalize RPC'; end if;
  if has_function_privilege('anon','public.lensed_void_batch(uuid,uuid)','EXECUTE')
    then raise exception 'void_batch reachable by anon'; end if;
  if has_function_privilege('authenticated','public.lensed_void_batch(uuid,uuid)','EXECUTE')
    then raise exception 'void_batch reachable by authenticated'; end if;
end $$;""")
    ok('new RPC: authenticated YES, anon NO, service_role YES; void_batch stays service-role-only') \
        if r.returncode == 0 else bad(f'grants: {r.stderr.strip().splitlines()[:2]}')
    return finish_part7()

def finish_part7():
    hdr('7. DIRECT POSTGREST BYPASS PROOF (real `authenticated` role, RLS enforced)')
    # production posture: RLS on with 035b's generic org-scoped policies + Supabase table grants
    r = psql("""
-- Real Supabase grants `authenticated` USAGE on the auth schema and EXECUTE on auth.uid();
-- the harness stubs that schema, so it must be granted here or every SECURITY INVOKER RPC
-- fails with "permission denied for schema auth" — a harness artifact, not a product defect.
grant usage on schema auth to authenticated, anon;
grant execute on function auth.uid() to authenticated, anon;
grant usage on schema public to authenticated, anon;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;
alter table public.sku_batches            enable row level security;
alter table public.inventory_skus         enable row level security;
alter table public.live_auction_item_skus enable row level security;
drop policy if exists sku_batches_org_upd on public.sku_batches;
create policy sku_batches_org_sel on public.sku_batches for select using (public.is_org_member(org_id));
create policy sku_batches_org_upd on public.sku_batches for update using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy isk_org_all on public.inventory_skus for all using (public.is_org_member(org_id)) with check (public.is_org_member(org_id));
create policy las_own_all on public.live_auction_item_skus for all using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy rev_org_sel on public.sku_batch_cost_revisions for select using (public.is_org_member(org_id));
""", stop=False)
    if r.returncode != 0: bad(f'RLS posture: {r.stderr.strip().splitlines()[:2]}')
    else: ok('RLS enabled on sku_batches with 035b-style org policies; table grants issued to `authenticated`')

    r = psql("""
create table if not exists public._pf_keep (sku uuid, batch uuid);
do $$
declare s uuid; b uuid; sess uuid;
begin
  insert into public.inventory_skus (user_id, org_id, sku_number, barcode, title, unit_cost_cents, qty_on_hand)
    values ('%(A)s','%(ORG)s', 901, 'BYPASS', 'Bypass proof', null, 0) returning id into s;
  select public.lensed_add_batch(s, 100, 300) into b;
  insert into public.live_sessions (user_id, status, started_at) values ('%(A)s','live', now()) returning id into sess;
  perform * from public.lensed_log_auction(sess,'sold',
    jsonb_build_array(jsonb_build_object('sku_id', s, 'qty', 10)), 'bypass-1', false, false);
  insert into public.capture_events (user_id, order_id, selling_price_cents, ordered_at)
    values ('%(A)s','bypass-1', 9000, now());
  insert into public._pf_keep values (s, b);
end $$;""" % {'A':A,'ORG':ORG1}, user_id=A)
    if r.returncode != 0: bad(f'bypass fixture: {r.stderr.strip().splitlines()[:3]}'); return 1
    keep = q('select sku, batch from public._pf_keep limit 1')
    if len(keep) != 2: bad('fixture missing'); return 1
    SKU, BAT = keep
    print(f'  fixture: 100 added @300, 10 consumed  (batch {BAT[:8]}…)')

    STATE = (f"select (select unit_cost_cents from public.sku_batches where id='{BAT}'),"
             f"(select coalesce(string_agg(coalesce(unit_cost_cents_snapshot::text,'~'),',' order by id),'') from public.live_auction_item_skus where source_batch_id='{BAT}'),"
             f"(select count(*) from public.sku_batch_cost_revisions where batch_id='{BAT}'),"
             f"(select qty_remaining from public.sku_batches where id='{BAT}'),"
             f"(select qty_on_hand from public.inventory_skus where id='{SKU}')")
    s0 = q(STATE)

    who = psql("select current_user, (select rolsuper from pg_roles where rolname=current_user)::text;",
               role='authenticated', user_id=A)
    print(f"  acting as: {' '.join(who.stdout.split()[-3:]) if who.returncode==0 else '?'}")

    # (a) the exact PostgREST write
    r = psql(f"update public.sku_batches set unit_cost_cents = 999 where id = '{BAT}';",
             stop=False, role='authenticated', user_id=A)
    if 'COST_EDIT_REQUIRES_FINALIZE' in (r.stderr + r.stdout):
        ok('direct UPDATE of unit_cost_cents by `authenticated` REFUSED (COST_EDIT_REQUIRES_FINALIZE)')
    else:
        bad(f'direct UPDATE was NOT refused: {(r.stdout+r.stderr).strip().splitlines()[:3]}')
    s1 = q(STATE)
    (ok if s0==s1 else bad)('nothing moved: cost, snapshots, revision count, qty_remaining, qty_on_hand all identical'
                            if s0==s1 else f'state changed despite refusal: {s0} -> {s1}')

    # (b) quantity-only direct UPDATE — intentionally still permitted
    r = psql(f"update public.sku_batches set qty_remaining = 89 where id = '{BAT}';",
             stop=False, role='authenticated', user_id=A)
    if 'UPDATE 1' in r.stdout: ok('quantity-only direct UPDATE still permitted (the guard is narrow, by design)')
    else: bad(f'quantity-only UPDATE blocked — guard too broad: {(r.stdout+r.stderr).strip().splitlines()[:2]}')
    psql(f"update public.sku_batches set qty_remaining = 90 where id = '{BAT}';")

    # (c) the sanctioned path, called as `authenticated`
    r = psql(f"select lines_repriced, units_repriced, cogs_delta_cents, revision_recorded "
             f"from public.lensed_finalize_batch_cost('{SKU}'::uuid, '{BAT}'::uuid, 999);",
             stop=False, role='authenticated', user_id=A)
    if r.returncode == 0 and '6990' in r.stdout:
        ok('finalize via the RPC as `authenticated` SUCCEEDED: 1 line / 10 units, COGS +6990, revision recorded')
    else:
        bad(f'sanctioned finalize failed: {(r.stdout+r.stderr).strip().splitlines()[:4]}')
    post = q(f"select (select unit_cost_cents from public.sku_batches where id='{BAT}'),"
             f"(select count(*) from public.live_auction_item_skus where source_batch_id='{BAT}' and unit_cost_cents_snapshot=999),"
             f"(select count(*) from public.sku_batch_cost_revisions where batch_id='{BAT}'),"
             f"(select qty_remaining from public.sku_batches where id='{BAT}'),"
             f"(select qty_on_hand from public.inventory_skus where id='{SKU}')")
    if len(post)==5:
        c,rp,rv,rem,qoh = post
        (ok if (c,rp,rv)==('999','1','1') else bad)(f'post-finalize: cost=999, 1 line repriced, 1 revision'
            if (c,rp,rv)==('999','1','1') else f'post-finalize wrong: cost={c} repriced={rp} revisions={rv}')
        (ok if (rem,qoh)==('90','90') else bad)('quantities untouched by the correction (90/90)'
            if (rem,qoh)==('90','90') else f'quantities moved: {rem}/{qoh}')
    return 0

if __name__ == '__main__':
    try:
        main()
    finally:
        sh(['docker','rm','-f',CONTAINER])
    print()
    if failures:
        print(f'❌ PREFLIGHT FAILED ({len(failures)})')
        for f in failures: print(f'   - {f}')
        sys.exit(1)
    print('✅ PREFLIGHT PASSED')
