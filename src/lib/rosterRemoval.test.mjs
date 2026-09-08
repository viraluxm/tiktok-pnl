// Regression tests for roster removal — the HOST_SEGMENT_IMMUTABLE production bug.
//
// WHAT BROKE: removing a person ran `delete from employees where id = $1`. Postgres then
// applied the ON DELETE SET NULL on live_session_host_segments.host_id (migration 106:178) as
// an UPDATE, trg_lshs_append_only refused it, and the whole transaction aborted with
// HOST_SEGMENT_IMMUTABLE. Anyone who had ever hosted a show was undeletable.
//
// WHY THE FAKE DB IS SHAPED LIKE THIS: a mock that only records calls would pass whether or
// not the fix is correct. This models the two database objects that actually produced the
// error — the referential action and the append-only trigger, transcribed from
// supabase/migrations/106_live_session_host_segments.sql — plus statement-level rollback, so
// the OLD code genuinely reproduces the production exception here (proved below) and the NEW
// code genuinely cannot. Nothing else about Postgres is simulated.
//
// Run:  TZ=UTC node src/lib/rosterRemoval.test.mjs

import { readFileSync, writeFileSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import ts from 'typescript';

function loadTs(relPath) {
  const srcPath = fileURLToPath(new URL(relPath, import.meta.url));
  const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const outFile = join(mkdtempSync(join(tmpdir(), 'rr-')), `${relPath.replace(/[^a-z]/gi, '_')}.mjs`);
  writeFileSync(outFile, outputText);
  return import(pathToFileURL(outFile).href);
}

const { removeFromRoster, buildRosterRemovalPatch, ROSTER_REMOVED_STATUS } =
  await loadTs('./rosterRemoval.ts');
const { visibleRoster, isFormer } = await loadTs('./weeklySchedule.ts');

let passed = 0;
const check = (name, cond, extra = '') => {
  assert.ok(cond, `FAIL: ${name} ${extra}`);
  console.log(`  ✓ ${name}${extra ? ` — ${extra}` : ''}`);
  passed++;
};

// ── The two database objects that caused the bug ─────────────────────────────

// lensed_guard_host_segment_append_only(), BEFORE UPDATE OR DELETE, FOR EACH ROW.
function guardHostSegmentAppendOnly(op, OLD, NEW) {
  if (op === 'DELETE') {
    throw new Error(`HOST_SEGMENT_APPEND_ONLY: segment ${OLD.id} cannot be deleted.`);
  }
  if (NEW.host_id !== OLD.host_id) {
    throw new Error(
      `HOST_SEGMENT_IMMUTABLE: host_id cannot be updated (segment ${OLD.id}). `
      + 'Insert a replacement and stamp superseded_by instead.',
    );
  }
  for (const col of ['started_at', 'session_id', 'user_id', 'source', 'created_at']) {
    if (NEW[col] !== OLD[col]) {
      throw new Error(`HOST_SEGMENT_IMMUTABLE: ${col} cannot be updated (segment ${OLD.id}).`);
    }
  }
  if (OLD.ended_at !== null && NEW.ended_at !== OLD.ended_at) {
    throw new Error(`HOST_SEGMENT_WRITE_ONCE: ended_at is already set on segment ${OLD.id}.`);
  }
  if (OLD.superseded_by !== null && NEW.superseded_by !== OLD.superseded_by) {
    throw new Error(`HOST_SEGMENT_WRITE_ONCE: superseded_by is already set on segment ${OLD.id}.`);
  }
  return NEW;
}

const segment = (o) => ({
  id: o.id, user_id: 'u1', session_id: o.session_id ?? 's1', host_id: o.host_id,
  started_at: o.started_at ?? '2026-08-01T00:00:00Z', ended_at: o.ended_at ?? null,
  source: o.source ?? 'session_create', ended_source: o.ended_source ?? null,
  superseded_by: o.superseded_by ?? null, created_at: '2026-08-01T00:00:00Z',
});

function makeDb() {
  return {
    employees: [
      { id: 'e-han', name: 'Hana', role: 'host', status: 'active', updated_at: 'T0' },
      { id: 'e-ora', name: 'Ora', role: 'host', status: 'active', updated_at: 'T0' },
      { id: 'e-pip', name: 'Pip', role: 'fulfillment', status: 'active', updated_at: 'T0' },
    ],
    // Hana hosted two shows and is mid-way through a third (open segment).
    live_session_host_segments: [
      segment({ id: 'sg-1', host_id: 'e-han', ended_at: '2026-08-01T04:00:00Z', ended_source: 'session_end' }),
      segment({ id: 'sg-2', host_id: 'e-han', session_id: 's2', ended_at: '2026-08-02T04:00:00Z', ended_source: 'session_end' }),
      segment({ id: 'sg-3', host_id: 'e-han', session_id: 's3' }), // open — no ended_at
      segment({ id: 'sg-4', host_id: 'e-ora', session_id: 's4', ended_at: '2026-08-03T04:00:00Z' }),
    ],
    shifts: [{ id: 'sh-1', employee_id: 'e-han' }, { id: 'sh-2', employee_id: 'e-ora' }],
    time_clock_entries: [{ id: 'tc-1', employee_id: 'e-han', minutes: 480 }],
    segmentWrites: [], // every write the "server" attempted against the segment table
  };
}

// Statement-level atomicity: a raised exception rolls the whole statement back, exactly as
// Postgres does. Without this the failing-delete tests would leave half-applied state.
function atomic(db, fn) {
  const before = JSON.stringify(db);
  try { return fn(); } catch (err) { Object.assign(db, JSON.parse(before)); throw err; }
}

// THE OLD CODE PATH: `delete from employees where id = $1`.
function hardDeleteEmployee(db, id) {
  return atomic(db, () => {
    for (const seg of db.live_session_host_segments) {
      if (seg.host_id !== id) continue;
      // FK live_session_host_segments_host_id_fkey ON DELETE SET NULL → an UPDATE.
      db.segmentWrites.push({ op: 'UPDATE', id: seg.id, cause: 'FK ON DELETE SET NULL' });
      Object.assign(seg, guardHostSegmentAppendOnly('UPDATE', seg, { ...seg, host_id: null }));
    }
    db.shifts = db.shifts.filter((s) => s.employee_id !== id);              // ON DELETE CASCADE
    db.time_clock_entries = db.time_clock_entries.filter((t) => t.employee_id !== id); // CASCADE
    db.employees = db.employees.filter((e) => e.id !== id);
    return { error: null };
  });
}

// Minimal PostgREST-shaped client over the model above.
function makeClient(db) {
  const run = (table, op, patch, id) => atomic(db, () => {
    if (table === 'live_session_host_segments') {
      const row = db.live_session_host_segments.find((r) => r.id === id);
      db.segmentWrites.push({ op, id, cause: 'direct' });
      if (op === 'DELETE') guardHostSegmentAppendOnly('DELETE', row, null);
      Object.assign(row, guardHostSegmentAppendOnly('UPDATE', row, { ...row, ...patch }));
      return row;
    }
    if (table === 'employees') {
      if (op === 'DELETE') return hardDeleteEmployee(db, id) && null;
      const row = db.employees.find((r) => r.id === id);
      if (!row) throw new Error('PGRST116: no rows returned');
      Object.assign(row, patch);
      return row;
    }
    if (op === 'INSERT') { db[table].push(patch); return patch; }
    throw new Error(`unsupported ${op} on ${table}`);
  });

  const settle = (table, op, patch, id) => {
    try { return Promise.resolve({ data: run(table, op, patch, id), error: null }); }
    catch (err) { return Promise.resolve({ data: null, error: err }); }
  };

  return {
    from(table) {
      return {
        update: (patch) => ({
          eq: (_c, id) => ({
            select: () => ({ single: () => settle(table, 'UPDATE', patch, id) }),
            then: (res, rej) => settle(table, 'UPDATE', patch, id).then(res, rej),
          }),
        }),
        insert: (row) => ({ select: () => ({ single: () => settle(table, 'INSERT', row) }) }),
        delete: () => ({
          eq: (_c, id) => ({ then: (res, rej) => settle(table, 'DELETE', null, id).then(res, rej) }),
        }),
      };
    },
  };
}

// ── 0. The fake reproduces the production bug ────────────────────────────────
console.log('\nRoot cause is real (old code path against the same schema model)');
{
  const db = makeDb();
  let err = null;
  try { hardDeleteEmployee(db, 'e-han'); } catch (e) { err = e; }
  check('hard DELETE of a host raises the production error', /^HOST_SEGMENT_IMMUTABLE: host_id cannot be updated/.test(err?.message ?? ''), err?.message?.slice(0, 62));
  check('…and rolls back — the person and their history survive the failure',
    db.employees.length === 3 && db.time_clock_entries.length === 1 && db.shifts.length === 2);
}
{
  // The other half of the old behaviour: for someone with NO segments the delete SUCCEEDED
  // and cascaded their pay history away. This is what the fix also stops.
  const db = makeDb();
  hardDeleteEmployee(db, 'e-pip');
  check('hard DELETE of a non-host succeeded — silently destructive by design',
    db.employees.length === 2);
}

// ── 1-5, 7-8. Roster removal ─────────────────────────────────────────────────
console.log('\nRemoving a person from the roster');
{
  const db = makeDb();
  const client = makeClient(db);
  const before = JSON.stringify(db.live_session_host_segments);

  const removed = await removeFromRoster(client, 'e-han'); // (8) WITH segment history

  check('1. removing a roster person succeeds', removed.status === 'former');
  check('   removal status is the schema-supported one', ROSTER_REMOVED_STATUS === 'former');
  check('2. historical host segment keeps its original host_id',
    db.live_session_host_segments.filter((s) => s.host_id === 'e-han').length === 3);
  check('3. no immutable-host update is attempted', db.segmentWrites.length === 0,
    `segment writes: ${db.segmentWrites.length}`);
  check('4. remaining roster members are unaffected',
    db.employees.find((e) => e.id === 'e-ora').status === 'active'
    && db.employees.find((e) => e.id === 'e-pip').status === 'active'
    && db.employees.length === 3);
  check('5. historical/completed segment records remain byte-identical',
    JSON.stringify(db.live_session_host_segments) === before);
  check('   an OPEN (active) segment is left open and still theirs — removal does not end a show',
    db.live_session_host_segments.find((s) => s.id === 'sg-3').ended_at === null
    && db.live_session_host_segments.find((s) => s.id === 'sg-3').host_id === 'e-han');
  check('   shifts, worked time and pay history are kept, not cascaded away',
    db.shifts.length === 2 && db.time_clock_entries.length === 1);
}
{
  const db = makeDb();                                       // (7) NO segment history
  const removed = await removeFromRoster(makeClient(db), 'e-pip');
  check('7. removing a person with no segment history works', removed.status === 'former');
  check('   their time records survive (the old delete cascaded them)',
    db.shifts.length === 2 && db.time_clock_entries.length === 1);
}
{
  const db = makeDb();
  const client = makeClient(db);
  await removeFromRoster(client, 'e-han');
  const again = await removeFromRoster(client, 'e-han');
  check('   removal is idempotent — archiving a former employee is not an error',
    again.status === 'former' && db.segmentWrites.length === 0);
}

// ── 6. The real correction path still works ──────────────────────────────────
console.log('\nSupersede/replacement still works (the operation the trigger DOES allow)');
{
  const db = makeDb();
  const client = makeClient(db);
  await db.live_session_host_segments.push(
    segment({ id: 'sg-5', host_id: 'e-ora', session_id: 's1', ended_at: '2026-08-01T04:00:00Z', source: 'manual_correction' }),
  );
  const { error } = await client.from('live_session_host_segments')
    .update({ superseded_by: 'sg-5' }).eq('id', 'sg-1');
  check('6. a correction may insert a replacement and stamp superseded_by', error === null);
  check('   the superseded row keeps its own host_id',
    db.live_session_host_segments.find((s) => s.id === 'sg-1').host_id === 'e-han');

  const second = await client.from('live_session_host_segments')
    .update({ superseded_by: 'sg-4' }).eq('id', 'sg-1');
  check('   superseded_by stays write-once', /HOST_SEGMENT_WRITE_ONCE/.test(second.error?.message ?? ''));

  const reassign = await client.from('live_session_host_segments')
    .update({ host_id: 'e-ora' }).eq('id', 'sg-2');
  check('   a direct host_id rewrite is still refused (trigger not weakened)',
    /HOST_SEGMENT_IMMUTABLE/.test(reassign.error?.message ?? ''));

  const del = await client.from('live_session_host_segments').delete().eq('id', 'sg-2');
  check('   segment DELETE is still blocked', /HOST_SEGMENT_APPEND_ONLY/.test(del.error?.message ?? ''));
}

// ── The patch itself cannot carry a segment column ───────────────────────────
console.log('\nThe removal payload');
{
  const patch = buildRosterRemovalPatch(new Date('2026-09-08T12:00:00Z'));
  check('patch writes only status + updated_at',
    JSON.stringify(Object.keys(patch).sort()) === JSON.stringify(['status', 'updated_at']));
  check('patch contains no host_id', !('host_id' in patch));
  check('patch sets the archived status', patch.status === 'former');
}

// ── 5-7. The active roster hides archived people ─────────────────────────────
console.log('\nThe active roster');
{
  const db = makeDb();
  const client = makeClient(db);
  const names = (list) => list.map((e) => e.name).sort().join(', ');

  check('6. active employees are visible by default',
    names(visibleRoster(db.employees, false)) === 'Hana, Ora, Pip');

  await removeFromRoster(client, 'e-han');

  check('5. the removed person disappears from the active roster',
    names(visibleRoster(db.employees, false)) === 'Ora, Pip');
  check('   …but the row is still there — archived, not deleted',
    db.employees.length === 3
    && db.employees.find((e) => e.id === 'e-han').status === 'former');
  check('   …and every other roster member is untouched',
    names(visibleRoster(db.employees, false)) === 'Ora, Pip'
    && db.employees.filter((e) => e.status === 'active').length === 2);

  check('7a. the toggle defaults to hidden (showFormer=false is the default arg the UI passes)',
    visibleRoster(db.employees, false).every((e) => !isFormer(e)));
  check('7b. turning the toggle on reveals them, clearly marked former',
    names(visibleRoster(db.employees, true)) === 'Hana, Ora, Pip'
    && visibleRoster(db.employees, true).filter(isFormer).map((e) => e.name).join() === 'Hana');
  check('   hiding is a view filter only — it never mutates the list it is given',
    db.employees.length === 3 && visibleRoster(db.employees, false) !== db.employees);
  check('   3+4. removal + hiding still leave segments and time records alone',
    db.segmentWrites.length === 0
    && db.live_session_host_segments.filter((s) => s.host_id === 'e-han').length === 3
    && db.shifts.length === 2 && db.time_clock_entries.length === 1);
}
{
  // A roster where everyone has been archived must not claim the team was never created.
  const db = makeDb();
  const client = makeClient(db);
  for (const id of ['e-han', 'e-ora', 'e-pip']) await removeFromRoster(client, id);
  check('   an all-former roster renders empty rather than hiding nothing',
    visibleRoster(db.employees, false).length === 0 && db.employees.length === 3);
}

// ── Static guard: nothing in the app may hard-delete an employee ─────────────
console.log('\nNo hard-delete path may come back');
{
  const SRC = fileURLToPath(new URL('..', import.meta.url));
  const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = join(dir, e.name);
    if (e.isDirectory()) return walk(full);
    return /\.(ts|tsx)$/.test(e.name) ? [full] : [];
  });
  const offenders = walk(SRC).filter((f) => {
    const src = readFileSync(f, 'utf8');
    return /from\(\s*['"`]employees['"`]\s*\)[\s\S]{0,120}?\.delete\s*\(/.test(src);
  });
  check('no source file issues .delete() against employees', offenders.length === 0,
    offenders.map((f) => f.replace(SRC, '')).join(', ') || 'clean');

  // The filter is only worth anything if the grid is actually fed the filtered list, and the
  // toggle is only correct if it starts off. Both are one edit away from silently regressing.
  const tab = readFileSync(join(SRC, 'components/employees/EmployeesTab.tsx'), 'utf8');
  check('the roster grid is fed the filtered list, not the raw one',
    /<RosterGrid[\s\S]{0,400}?employees=\{roster\}/.test(tab)
    && /const roster = useMemo\(\(\) => visibleRoster\(employees, showFormer\)/.test(tab));
  check('the show-former toggle defaults to OFF',
    /const \[showFormer, setShowFormer\] = useState\(false\)/.test(tab));

  // Copy contract: the dialog must not promise a deletion the code no longer performs.
  const confirmBody = tab.slice(tab.indexOf('async function handleRemove'), tab.indexOf('async function copyAllLinks'));
  check('the confirmation never says anything will be deleted', !/delet/i.test(confirmBody));
  check('the confirmation states what is kept',
    /historical shifts/.test(confirmBody) && /host history will be kept/.test(confirmBody));
}

console.log(`\n${passed} checks passed\n`);
