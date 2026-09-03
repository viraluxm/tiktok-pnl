// autoEnd -> host-segment close (Phase 2d). Exercises the REAL autoEndSessions() from
// autoEnd.ts, transpiled at runtime with '@/lib/supabase/admin' rewired to a mock — the same
// pattern src/lib/labor.test.mjs uses.
//
// What this has to prove, not assert:
//   1. the dry run is NON-EMPTY and carries the fields needed to review it before writing
//   2. the close instant is proposed_ended_at, NEVER now() (autoEnd trims the idle tail; now()
//      would hand the host every minute being trimmed)
//   3. it calls close_session_host_segment_AS (service role), not the auth.uid() variant
//   4. a FAILING segment close never prevents a session from ending
//   5. multiLive sessions get no close at all
//   6. nothing is written while SEGMENT_CLOSE_WRITE_ENABLED is off
//
// Run: TZ=UTC node src/lib/sessions/autoEnd.segments.test.mjs
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import ts from 'typescript';

let pass = 0, fail = 0;
const ok = (n, c, x) => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (x ? '  → ' + x : '')); } };

const dir = mkdtempSync(join(tmpdir(), 'autoend-'));
const iso = (ms) => new Date(ms).toISOString();
const MIN = 60_000, HOUR = 60 * MIN;
const NOW = Date.now();

// ── mock admin client ────────────────────────────────────────────────────────────────────
// Chainable + awaitable at any point, matching the supabase-js surface autoEnd uses.
function makeAdmin(fixture) {
  const rpcCalls = [];
  const updates = [];
  function qb(resolver) {
    const self = {
      select: () => self, eq: () => self, gte: () => self, lt: () => self,
      is: () => self, in: (_c, v) => { self._in = v; return self; },
      order: () => self,
      // .range() is HONOURED, not swallowed. A mock that ignored it would return the full set
      // on page 1 and make paging look correct no matter how it was written — hiding exactly
      // the truncation this exists to prevent.
      range: (from, to) => { self._range = [from, to]; return self; },
      update: (patch) => { self._patch = patch; return self; },
      then: (res, rej) => Promise.resolve(resolver(self)).then((r) => {
        if (self._range && r && Array.isArray(r.data)) {
          const [from, to] = self._range;
          return { ...r, data: r.data.slice(from, to + 1) };
        }
        return r;
      }).then(res, rej),
    };
    return self;
  }
  return {
    rpcCalls, updates,
    from(table) {
      if (table === 'live_sessions') {
        return qb((s) => {
          if (s._patch) { updates.push(s._patch); return fixture.updateResult ?? { error: null }; }
          return { data: fixture.sessions, error: null };
        });
      }
      if (table === 'capture_events') return qb(() => ({ data: fixture.capturesFor(), error: null }));
      if (table === 'live_session_host_segments') {
        return qb(() => ({ data: fixture.openSegments, error: null }));
      }
      return qb(() => ({ data: [], error: null }));
    },
    rpc(name, args) {
      rpcCalls.push({ name, args });
      return Promise.resolve(fixture.rpcResult ?? { data: null, error: null });
    },
  };
}

// autoEnd reads captures per-session; a single shared list is enough because the fixture uses
// one closable session with captures and the others are shaped by their own rows.
/**
 * The paged reader autoEnd now depends on. Transpiled from the REAL source rather than
 * stubbed, so the exhaustion behaviour under test is the one that actually ships — a stub
 * here would hide the very truncation the paging was added to prevent.
 */
function transpileReadAll() {
  const srcPath = fileURLToPath(new URL('../db/readAll.ts', import.meta.url));
  const { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  const out = join(dir, 'readAll.mjs');
  writeFileSync(out, outputText);
  return pathToFileURL(out).href;
}

function transpileAutoEnd(adminUrl) {
  const srcPath = fileURLToPath(new URL('./autoEnd.ts', import.meta.url));
  let { outputText } = ts.transpileModule(readFileSync(srcPath, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  outputText = outputText.split("'@/lib/supabase/admin'").join(`'${adminUrl}'`);
  outputText = outputText.split("'@/lib/db/readAll'").join(`'${transpileReadAll()}'`);
  const out = join(dir, 'autoEnd.mjs');
  writeFileSync(out, outputText);
  return pathToFileURL(out).href;
}

const OWNER = 'owner-user-1';
const SESS_CLOSE = 'sess-closable';
const SEG_OPEN = 'seg-open-1';
const HOST = 'emp-host-1';
// closable: heartbeat 30m stale (> AUTO_END_MINUTES 10) AND captures 60m stale (> IDLE 45)
const SESSION_START = NOW - 6 * HOUR;
const LAST_CAPTURE = NOW - 60 * MIN;
const LAST_HEARTBEAT = NOW - 30 * MIN;
const SEG_START = NOW - 5 * HOUR;

function baseFixture(over = {}) {
  return {
    sessions: [{ id: SESS_CLOSE, user_id: OWNER, store_id: 'store-1', started_at: iso(SESSION_START), ended_at: null, last_seen_at: iso(LAST_HEARTBEAT) }],
    capturesFor: () => [{ created_at: iso(SESSION_START + MIN) }, { created_at: iso(LAST_CAPTURE) }],
    openSegments: [{ id: SEG_OPEN, session_id: SESS_CLOSE, host_id: HOST, started_at: iso(SEG_START) }],
    ...over,
  };
}

async function load(fixture) {
  const adminFile = join(dir, `admin-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(adminFile, 'export let __admin; export function __set(a){__admin=a;} export function createAdminClient(){return __admin;}');
  const adminUrl = pathToFileURL(adminFile).href;
  const adminMod = await import(adminUrl);
  const admin = makeAdmin(fixture);
  adminMod.__set(admin);
  const mod = await import(transpileAutoEnd(adminUrl) + `?v=${Math.random()}`);
  return { autoEndSessions: mod.autoEndSessions, admin };
}

async function run() {
  // ── 1. DRY RUN is non-empty and reviewable ───────────────────────────────────────────
  {
    delete process.env.SEGMENT_CLOSE_WRITE_ENABLED;
    const { autoEndSessions, admin } = await load(baseFixture());
    const r = await autoEndSessions({ write: false });
    ok('1) dry run identifies the session as would-close', r.would_close_count === 1, JSON.stringify(r.would_close));
    ok('1) dry run segments_would_close is NON-EMPTY', r.segments_would_close_count === 1, JSON.stringify(r.segments_would_close));
    const s = (r.segments_would_close || [])[0] || {};
    ok('1) …carries session, owner, segment, host, both instants and the resulting duration',
       s.session_id === SESS_CLOSE && s.owner_user_id === OWNER && s.segment_id === SEG_OPEN &&
       s.host_id === HOST && !!s.segment_started_at && !!s.proposed_ended_at &&
       typeof s.resulting_duration_minutes === 'number' && s.inverted === false,
       JSON.stringify(s));
    ok('1) dry run wrote NOTHING (no updates, no rpc)',
       admin.updates.length === 0 && admin.rpcCalls.length === 0,
       `updates=${admin.updates.length} rpc=${admin.rpcCalls.length}`);
    ok('1) flag reported as off', r.segment_close_write_enabled === false);
  }
  // ── 2. proposed_ended_at, NOT now() ──────────────────────────────────────────────────
  {
    const { autoEndSessions } = await load(baseFixture());
    const r = await autoEndSessions({ write: false });
    const s = (r.segments_would_close || [])[0] || {};
    const w = (r.would_close || [])[0] || {};
    ok('2) segment close instant === the session\'s proposed_ended_at',
       s.proposed_ended_at === w.proposed_ended_at, `${s.proposed_ended_at} vs ${w.proposed_ended_at}`);
    const ageMin = s.proposed_ended_at ? (NOW - new Date(s.proposed_ended_at).getTime()) / MIN : -1;
    ok('2) …and it is ~30m in the PAST, not now() (the trimmed idle tail is not credited)',
       ageMin > 20 && ageMin < 45, `proposed_ended_at is ${ageMin.toFixed(1)}m before now`);
    const dur = s.resulting_duration_minutes;
    ok('2) resulting duration reflects the trim, not the full span to now()',
       dur > 0 && dur < (NOW - SEG_START) / MIN, `duration=${dur}m  span_to_now=${((NOW - SEG_START) / MIN).toFixed(1)}m`);
  }
  // ── 3. WRITE with the flag ON calls the SERVICE-ROLE _as variant ─────────────────────
  {
    process.env.SEGMENT_CLOSE_WRITE_ENABLED = 'true';
    const { autoEndSessions, admin } = await load(baseFixture());
    const r = await autoEndSessions({ write: true });
    ok('3) the session was ended', r.closed === 1, JSON.stringify(r.closed));
    ok('3) exactly one rpc call was made', admin.rpcCalls.length === 1, JSON.stringify(admin.rpcCalls));
    const c = admin.rpcCalls[0] || {};
    ok('3) it is close_session_host_segment_AS, not the auth.uid() variant',
       c.name === 'close_session_host_segment_as', String(c.name));
    ok('3) …with the owner passed explicitly and p_source=session_end',
       c.args && c.args.p_owner_user_id === OWNER && c.args.p_session_id === SESS_CLOSE &&
       c.args.p_source === 'session_end', JSON.stringify(c.args));
    ok('3) …and p_at = proposed_ended_at, not now()',
       c.args && c.args.p_at === r.would_close[0].proposed_ended_at, JSON.stringify(c.args && c.args.p_at));
    ok('3) segments_closed counted', r.segments_closed === 1, String(r.segments_closed));
  }
  // ── 4. a FAILING close never blocks the session end ──────────────────────────────────
  {
    process.env.SEGMENT_CLOSE_WRITE_ENABLED = 'true';
    const { autoEndSessions, admin } = await load(baseFixture({ rpcResult: { data: null, error: { message: 'boom: simulated RPC failure' } } }));
    const r = await autoEndSessions({ write: true });
    ok('4) session STILL ended despite the segment close failing', r.closed === 1, String(r.closed));
    ok('4) the failure is recorded, not swallowed silently',
       (r.segment_close_errors || []).length === 1 && String(r.segment_close_errors[0].error).includes('boom'),
       JSON.stringify(r.segment_close_errors));
    ok('4) segments_closed did NOT count the failure', r.segments_closed === 0, String(r.segments_closed));
    ok('4) …and the rpc was genuinely attempted (not a vacuous pass)', admin.rpcCalls.length === 1, String(admin.rpcCalls.length));
  }
  // ── 5. a THROWING close is also non-fatal ────────────────────────────────────────────
  {
    process.env.SEGMENT_CLOSE_WRITE_ENABLED = 'true';
    const fx = baseFixture();
    const { autoEndSessions, admin } = await load(fx);
    admin.rpc = () => { admin.rpcCalls.push({ name: 'threw' }); throw new Error('network exploded'); };
    const r = await autoEndSessions({ write: true });
    ok('5) session STILL ended when the rpc THROWS', r.closed === 1, String(r.closed));
    ok('5) the throw is captured as an error entry',
       (r.segment_close_errors || []).length === 1 && String(r.segment_close_errors[0].error).includes('exploded'),
       JSON.stringify(r.segment_close_errors));
  }
  // ── 6. multiLive gets no close ───────────────────────────────────────────────────────
  {
    process.env.SEGMENT_CLOSE_WRITE_ENABLED = 'true';
    // captures across 2 Pacific days with a >6h internal gap ⇒ multiLive, never auto-closed
    const t0 = Date.parse('2026-08-10T02:00:00Z');
    const fx = baseFixture({
      sessions: [{ id: 'sess-multi', user_id: OWNER, store_id: 'store-1', started_at: iso(t0), ended_at: null, last_seen_at: iso(t0 + 30 * MIN) }],
      capturesFor: () => [{ created_at: iso(t0) }, { created_at: iso(t0 + 20 * HOUR) }],
      openSegments: [{ id: 'seg-multi', session_id: 'sess-multi', host_id: HOST, started_at: iso(t0) }],
    });
    const { autoEndSessions, admin } = await load(fx);
    const r = await autoEndSessions({ write: true });
    ok('6) the session is flagged multiLive', r.multi_live_count === 1, JSON.stringify(r.multi_live));
    ok('6) multiLive is NOT auto-closed', r.would_close_count === 0, String(r.would_close_count));
    ok('6) …and its open segment is NOT closed', r.segments_would_close_count === 0 && admin.rpcCalls.length === 0,
       `segs=${r.segments_would_close_count} rpc=${admin.rpcCalls.length}`);
  }
  // ── 7. flag OFF ⇒ session ends, segment untouched ────────────────────────────────────
  {
    process.env.SEGMENT_CLOSE_WRITE_ENABLED = 'false';
    const { autoEndSessions, admin } = await load(baseFixture());
    const r = await autoEndSessions({ write: true });
    ok('7) flag off: session still ends', r.closed === 1, String(r.closed));
    ok('7) flag off: NO segment rpc fired', admin.rpcCalls.length === 0, JSON.stringify(admin.rpcCalls));
    ok('7) flag off: dry-run data still populated for review', r.segments_would_close_count === 1, String(r.segments_would_close_count));
  }

  console.log('');
  // ── 8. MORE THAN 1000 CAPTURES: the read must not truncate ───────────────────────────
  //
  // The regression this guards. PostgREST silently caps a response at 1000 rows, and this read
  // is ordered ASCENDING — so a truncated read drops the most RECENT captures, the very ones
  // proving a show is still live. autoEnd would then judge the session on a stale tail.
  //
  // Asserted on the reported CAPTURE COUNT rather than on whether the session closed. The
  // close decision runs through AUTO_END_MINUTES, IDLE_THRESHOLD_MIN and the multi-live guard,
  // so a fixture tuned to flip it is fragile and — as an earlier version of this test proved by
  // passing with the truncation deliberately reintroduced — can easily assert nothing at all.
  // The count is the truncation, directly.
  {
    delete process.env.SEGMENT_CLOSE_WRITE_ENABLED;
    const TOTAL = 1200;
    const many = Array.from({ length: TOTAL }, (_, i) => ({
      created_at: iso(SESSION_START + i * MIN),
    }));
    const { autoEndSessions } = await load(baseFixture({ capturesFor: () => many }));
    const res = await autoEndSessions({ nowMs: SESSION_START + (TOTAL + 1) * MIN });
    const all = [
      ...(res.would_close ?? []), ...(res.still_active ?? []),
      ...(res.multi_live ?? []), ...(res.no_captures ?? []),
    ];
    const row = all.find((r) => r.id === SESS_CLOSE);
    ok(`8) all ${TOTAL} captures are read, not 1000`,
      !!row && row.captures === TOTAL,
      row ? `reported ${row.captures}` : 'session missing from the dry run');
  }

  console.log(fail === 0 ? `ALL PASS: ${pass} passed, 0 failed` : `FAILED: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}
run();
