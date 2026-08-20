# Phase 2 release checklist — host segments (extension v0.7.0)

**Status:** awaiting review. Nothing distributed. No host machine has this build.

## What ships in this one build

| part | branch | what |
|---|---|---|
| 2a | `feat/ext-room-keyed-host` | host state keyed by room, not one global scalar |
| 2b | `feat/ext-segment-writer` | `open_session_host_segment` replaces `set_session_host` |
| 2c | `feat/ext-segment-close-paths` | close on room change / user change / tab close / live end |
| 2d | `feat/autoend-closes-segments` | server-side close via `close_session_host_segment_as` (flagged off) |
| 2e | `feat/ext-capture-dedupe` | `ext_version` stamp + one capture-row definition + manifest 0.7.0 |

Each branch stacks on the previous one; `feat/ext-capture-dedupe` is the tip and contains all of it.

**Migrations required, all APPLIED:** 106, 108, 110, 112, 113. (107 is still gated and is NOT
required by this build — nothing reads `host_id_snapshot`.)

---

## 1. Pre-flight — resolve the deployed version

**BLOCKER.** The version currently running on host machines is unverified. `ext_version` is NULL
for every `capture_events` row ever written (the stamp ships *in* this build, so it cannot answer
the question yet) and `ext_diag_events` is empty.

- [ ] Confirm the deployed version out-of-band — Chrome Web Store / self-hosted listing, or have
      a host read the overlay diagnostics panel.
- [ ] Confirm `0.7.0` is above it. Built artifacts in the tree run to `0.6.5`, so `0.7.0` clears
      everything present, but *present in the tree* is not the same as *deployed*.

After this build, the question is answerable from data. It is not answerable now.

## 2. Backfill re-run — immediately before distribution

The 106 backfill was a one-shot `INSERT … WHERE NOT EXISTS` that ran at **2026-08-19 23:11:32Z**.
Every hosted session created since then has a `host_id` and no segment.

**Current gap: 6 sessions**, earliest `2026-08-19 23:17:02Z`. It grows with every show.

- [ ] Run section D of `supabase/migrations/106_live_session_host_segments.sql` verbatim.
      Idempotent — the `NOT EXISTS` guard skips any session that already has a segment.
- [ ] Run it **after the last pre-Phase-2 show and before the first Phase-2 show.**
- [ ] Confirm afterwards: `NEED_BACKFILL_NOW = 0`.

Ordering only matters for tidiness: the guard is per-session, so a session that already has an
extension-written segment is skipped either way and can never end up with both a
`backfill_legacy` and a live segment.

## 3. Build

- [ ] Full extension suite green: `for t in extension/test/*.test.mjs; do node "$t"; done` → **11/11**
- [ ] App-side suite green: `node src/lib/sessions/autoEnd.segments.test.mjs` → 26/26,
      `node src/lib/sessions/sessionEnd.drift.test.mjs` → 6/6
- [ ] `npx tsc --noEmit` clean
- [ ] `bash extension/build.sh` → one zip, `lensed-extension-v0.7.0.zip`
- [ ] `node extension/validate-build.mjs extension/dist`

**One build, one zip, one smoke test.** Do not distribute for `ext_version` alone — that was the
explicit reason these five parts were batched.

## 4. Leave `SEGMENT_CLOSE_WRITE_ENABLED` OFF

2d ships flagged off deliberately. Its dry run is only meaningful once the extension has actually
opened segments, so the sequence is:

- [ ] distribute the build, run one full show
- [ ] run the auto-ender dry run; confirm `segments_would_close` is **non-empty**
- [ ] for each entry check `proposed_ended_at` is inside the show window and
      `segment_started_at < proposed_ended_at` (`inverted: false`)
- [ ] only then set `SEGMENT_CLOSE_WRITE_ENABLED=true`
- [ ] re-run; confirm the segments closed with `ended_source='session_end'`

An empty `segments_would_close` means the writer is not opening segments — **the flag stays off.**

---

## 5. Smoke test — on a real live, before any host machine

### Auth constraint — non-negotiable

Per CLAUDE.md, anything that establishes a *different* Supabase session on a machine replaces the
capture JWT and captures silently write under the wrong `user_id`, invisibly.

- Run under the **same owner account hosts use**.
- On a machine that is **not** a host's.
- **Never** sign a sub-user into lensed.io on a host machine.

Load unpacked on that one controlled machine.

### Sequence

| # | action | assertion |
|---|---|---|
| 1 | let one sale land | the new `capture_events` row has `ext_version = '0.7.0'` — proves the stamp AND that the dedupe did not drop it |
| 2 | select host A | exactly 1 open segment; `host_id` = A; `source` ∈ {`session_create`,`session_reuse`}; `live_sessions.host_id` = A |
| 3 | 2+ more sales | `pnl_show_host_segments` shows A with those auctions and **no `Unattributed` row** |
| 4 | **switch to host B** | see §6 |
| 5 | 2+ more sales | they attribute to **B**, not A |
| 6 | open a second live tab, pick host C | A/B's room keeps its own host; C's room gets C. **This is the 2a regression** — verify at the segment level, not just the dropdown |
| 7 | end the live | the open segment closes with `ended_source = 'session_end'` |
| 8 | conservation | `sum(auctions)` from `pnl_show_host_segments` = the session's sold count |
| 9 | force a failure — pick a host, then set an employee to `status='former'` and re-pick them | the overlay shows the persistent `⚠ HOST NOT SAVED` state, **not** a clean selection (spec §10) |

### Rollback

Reinstall the previous zip. Segments already written stay — additive, and the only consumers are
the new read functions. No data repair needed.

---

## 6. Verifying the mid-show switch (step 4)

```sql
select s.id, e.name as host, s.started_at, s.ended_at, s.source, s.ended_source,
       lead(s.started_at) over (order by s.started_at) as next_starts_at,
       s.ended_at = lead(s.started_at) over (order by s.started_at) as boundary_contiguous
from public.live_session_host_segments s
left join public.employees e on e.id = s.host_id
where s.session_id = '<session>' and s.superseded_by is null
order by s.started_at;
```

Must all hold:

- **exactly 2 rows** for a single switch
- `row1.ended_at = row2.started_at` — `boundary_contiguous` true. Migration 112 makes this
  structural rather than incidental; no gap (sales lost to `Unattributed`) and no overlap (sales
  **counted twice**)
- `row1.ended_source = 'extension_switch'`, `row2.ended_at is null` while live
- exactly **1** open segment
- neither segment zero-length (`started_at < ended_at`)
- a sale timestamped before the boundary → A; at or after → B (half-open between segments,
  closed only at the session ceiling)
- **force the edge case:** a sale in the same second as the switch must attribute to **B**, the
  incoming host

Then cross-check `pnl_show_hourly_by_host`: the switch hour splits across A and B, and those two
rows sum to that hour's row in `pnl_show_hourly`.

---

## 7. Known-good reference

The acceptance test on session `a5ff7a90` (5.86h, 400 real sold sales), driven entirely through
the applied RPCs — open, two switches, `session_end`, then a `room_change_close` that correctly
no-ops:

```
host            hours  segs  auctions  units     revenue
Madison          4.00     1       265    273    $1235.00
Bella            1.00     1        75     76     $372.00
Ivy              0.85     1        60     63     $258.00
TOTAL                             400
Unattributed: none
```

If a real show does not produce this shape, stop and compare against it.

## 8. Open risks carried into this release

- **R2 clock skew** — mitigated by 112 (an instant at or before the open segment's start falls
  back to `now()`), but a machine with a badly wrong clock still gets its switch instants
  substituted. Detect with `started_at = ended_at`.
- **R3 contiguity guard untested** — the 45-minute gap fires on 0 of 201 real sessions. It is
  insurance; a genuinely long mid-show gap would be its first real exercise.
- **Head-of-show cap** — 113 refuses reach-backs beyond 45 minutes, leaving ~57 sales on two
  outlier sessions permanently unattributed. Deliberate: those are sessions created long after
  their show began, not head-of-show artifacts.
- **`/api/member/team/host-performance`** now matches the Roster (111), but any *future* read of
  host performance must use the same anchor or the two will diverge again.
