// Drift test: the SQL contiguity guard MUST equal autoEnd.ts's IDLE_THRESHOLD_MIN.
//
// migration 106's lensed_session_activity_end decides when a show stopped selling by walking
// the sales and cutting at the first gap wider than a contiguity guard. That guard is not an
// independent number — it is IMPORTED from src/lib/sessions/autoEnd.ts, which has been using
// IDLE_THRESHOLD_MIN in production to decide the same thing. Two subsystems disagreeing about
// when a show ended is the bug this test exists to prevent.
//
// Deliberately a TEXT check, not a refactor. autoEnd.ts is explicitly not to be restructured
// to share a constant with SQL (its header says: do NOT change the closing logic here), so the
// duplication is accepted and pinned instead.
//
// Run: node src/lib/sessions/sessionEnd.drift.test.mjs

import fs from 'fs';
import path from 'path';

const ROOT = process.cwd();
const AUTO_END = path.join(ROOT, 'src/lib/sessions/autoEnd.ts');
const MIGRATION = path.join(ROOT, 'supabase/migrations/106_live_session_host_segments.sql');

let failed = 0;
const ok = (name, cond, detail) => {
  if (cond) { console.log(`  ✓ ${name}`); }
  else { failed += 1; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
};

// ── source of truth ──────────────────────────────────────────────────────────
const autoEndSrc = fs.readFileSync(AUTO_END, 'utf8');
const tsMatch = autoEndSrc.match(/export\s+const\s+IDLE_THRESHOLD_MIN\s*=\s*(\d+)\s*;/);
ok('autoEnd.ts still exports IDLE_THRESHOLD_MIN as a literal', !!tsMatch,
   'the regex found nothing — if the constant was renamed or computed, update this test rather than deleting it');
const idleThresholdMin = tsMatch ? Number(tsMatch[1]) : null;

// ── the SQL constant ─────────────────────────────────────────────────────────
const sqlSrc = fs.readFileSync(MIGRATION, 'utf8');
// Matches:  interval '45 minutes' as contiguity_gap
const sqlMatch = sqlSrc.match(/interval\s+'(\d+)\s*minutes'\s+as\s+contiguity_gap/i);
ok('106 still declares contiguity_gap as an interval literal', !!sqlMatch,
   'the CTE constant was renamed or restructured');
const contiguityGapMin = sqlMatch ? Number(sqlMatch[1]) : null;

// ── the assertion this file exists for ───────────────────────────────────────
ok(`contiguity_gap (${contiguityGapMin}m) === IDLE_THRESHOLD_MIN (${idleThresholdMin}m)`,
   idleThresholdMin !== null && contiguityGapMin === idleThresholdMin,
   'these two decide when a show ended and must not diverge. Change BOTH, or neither.');

// ── the zero-grace decision is explicit, not accidentally absent ─────────────
const graceMatch = sqlSrc.match(/interval\s+'(\d+)\s*minutes'\s+as\s+wind_down_grace/i);
ok('106 still declares wind_down_grace explicitly', !!graceMatch,
   'the named zero was removed — an absent grace is not the same as a documented zero');
ok('wind_down_grace is still 0', graceMatch ? Number(graceMatch[1]) === 0 : false,
   graceMatch ? `found ${graceMatch[1]}m; a non-zero grace manufactures selling time nobody observed — if intended, update this test with the rationale` : undefined);

// ── last_seen_at must remain a ceiling, never an extender ────────────────────
ok('last_seen_at is still used only inside LEAST (ceiling, never extender)',
   /least\(\s*\(select run_end from run\)[\s\S]{0,200}?ses\.last_seen_at/i.test(sqlSrc)
     && !/greatest\([^)]*last_seen_at/i.test(sqlSrc),
   'last_seen_at appears in a GREATEST — as an extender it produced a 46.9h phantom-hours bug');

console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
