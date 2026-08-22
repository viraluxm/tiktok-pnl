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

**Migrations — all seven APPLIED.**

| | required by this build | why |
|---|---|---|
| 106, 108, 110, 112, 113 | **yes** | the segment table, the service-role close, the source vocabulary, the boundary fixes, the head-of-show reach-back |
| 109, 111 | no | the host-performance anchor fix and its owner-scoped twin. Applied, and their route changes already shipped to `main` — listed here so their absence from the "required" set reads as a distinction rather than an omission |
| 107 | **not applied** | still write-silence gated. Not needed: nothing reads `host_id_snapshot` yet |

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

- [ ] Run it using the exact command in **§11** — `supabase/backfill/phase2_backfill_rerun.sql`.
      Do NOT re-derive it from migration 106; §11 and that file are the single instruction.
- [ ] Run it **after the last pre-Phase-2 show and before the first Phase-2 show.**
- [ ] Confirm afterwards with §11's verification query: it must return **0**.

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
| 9 | force a failure — pick a host, then set an employee to `status='former'` and re-pick them | persistent `⚠ HOST NOT SAVED — inactive, pick someone else` next to the dropdown, the dropdown itself outlined red (`lensed-host-unsaved`), and the underlying DB error in the element's tooltip. **Not** a clean selection, and **not** a toast that fades. |

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

---

# 9. Merge / build sequence

The five branches are a **stack** — each was branched off the previous one, so each already
contains its predecessors. `feat/ext-capture-dedupe` is the tip and contains all five.

```
main
 └─ feat/ext-room-keyed-host        (2a)
     └─ feat/ext-segment-writer     (2b)
         └─ feat/ext-segment-close-paths   (2c)
             └─ feat/autoend-closes-segments (2d)
                 └─ feat/ext-capture-dedupe  (2e)  ← tip, contains everything
```

Plus one independent branch off `main` that is **already applied to the DB** and needs its file
recorded: `fix/segment-head-of-show` (113).

### Recommended: ONE merge commit from the tip, no squash

- [ ] Open **one PR: `feat/ext-capture-dedupe` → `main`.**
- [ ] Merge with a **merge commit** (`--merge`), **NOT squash.**
- [ ] Do **not** open PRs for 2a–2d individually. They are ancestors of the tip; merging the tip
      brings them with their individual commits intact.

**Why not squash:** the commit messages carry the mutation-proof results, the measured numbers,
and the reasoning for each decision. Squashing collapses five reviewable units into one blob and
loses the per-part attribution — and if a bisect is ever needed, 2a (a standalone correctness
fix) must stay separately revertable from 2b–2e.

**Why not merge each branch separately:** it produces five PRs whose diffs are cumulative and
therefore mostly redundant, and four intermediate `main` states where the extension calls
`open_session_host_segment` with no close paths (2b alone) — a state that should never be a
deployable `main`.

### Also needs to land

- [ ] `fix/segment-head-of-show` (113) — **separate PR, merge first.** It is applied to the DB and
      the repo is the only record of what has run; leaving it unmerged means `main` does not
      record reality.
- [ ] Confirm after both merges that `main` contains files 106 through 113, and that 107 still
      carries its `NOT APPLIED — write-silence gated` header.

### Order

1. [ ] Merge `fix/segment-head-of-show` → `main` (113 file, records applied state).
2. [ ] Rebase or merge `main` into `feat/ext-capture-dedupe`; re-run the full suite.
3. [ ] Merge `feat/ext-capture-dedupe` → `main` (2a–2e).
4. [ ] **Only now** build the zip, from `main`.

Building from a feature branch is what let 0.6.4/0.6.5 diverge in the first place. Build from
`main` after the merge, so the zip corresponds to a commit that exists on `main`.

### CI note

`rpc-grants` will be **red** — it has been failing on missing repo secrets since at least
2026-08-16, across every branch, and three PRs merged past it. Once the secrets are restored,
re-run it against `main`: a local run currently reports three pre-existing registry gaps
(`pnl_by_period_as`, `pnl_by_show_as`, `pnl_show_hourly_as`) tracked separately. Do not treat a
red `rpc-grants` as approval to skip reading it.

---

# 10. If the smoke test fails — per step

**The extension is already loaded on your machine at this point, and a live may be running.**
The governing facts:

- Segments are **additive**. Nothing pre-Phase-2 reads them. A wrong segment does not corrupt
  capture, binding, revenue, P&L, or payroll.
- `live_sessions.host_id` is still maintained by `open_session_host_segment`, so the nine
  pre-existing consumers keep working even if segments are wrong.
- **Capture is never blocked** by any host-segment failure. Sales keep landing in
  `capture_events` regardless.

So there is no scenario below where the correct response is to panic mid-show.

### FIRST, AT EVERY STEP, BEFORE ANYTHING ELSE — capture the diagnostics ring

**Do this on any failure at any step, on any machine, before touching the extension.**

- [ ] Open the overlay's diagnostics panel and export/copy the ring.

It is the **only** forensic record of what happened. It lives in memory in the service worker
and the page, it is **local-only** (`ext_diag_events` is not being uploaded — the table is
empty), and it is destroyed by removing the extension, reloading the tab, or the worker being
evicted. Every `host.segment_open`, `host.segment_error`, `host.segment_close`,
`host.segment_close_error`, `host.save_failed` and `host.deferred_timeout` event lives there and
nowhere else.

If you skip this and roll back, the failure is unreproducible and undiagnosable.

### Universal rollback (any step)

1. [ ] Ring captured (above). **Do not skip.**
2. [ ] `chrome://extensions` → **Remove** the unpacked 0.7.0 → **Load unpacked** the previous zip.
3. [ ] Reload the live tab. Capture resumes on the old build immediately.
4. [ ] Leave the segments written so far **in place** — they are additive and diagnostic. Do not
       delete them; the append-only trigger blocks row deletes anyway, and they are the evidence
       of what went wrong.

Reverting the extension does **not** require reverting any migration. All seven are additive and
harmless with no writer.

### Step-specific

| step | failure | what it means | action |
|---|---|---|---|
| 1 | `ext_version` NULL on the new row | the stamp or the dedupe broke | **Stop.** Universal rollback. This is the one failure that indicates a bad build rather than a bad behaviour — do not continue the test. |
| 2 | no open segment, or `host_id` wrong | the writer is not firing | Check the overlay for `⚠ HOST NOT SAVED`. If shown, read the classified error — an `INVALID_SOURCE` means a vocabulary gap (a 110 regression); anything else is likely auth/session. Rollback; capture the ring. |
| 3 | an `Unattributed` row appears | 113's reach-back or the boundary is wrong | **Do not roll back mid-show** — capture is fine and the numbers are diagnostic. Finish the show, then compare against §7. This is a read-path bug, fixable without touching the extension. |
| 4/6 | boundaries not contiguous, or overlap | a 112 regression | Finish the show; **do not flip `SEGMENT_CLOSE_WRITE_ENABLED`.** Overlap double-counts revenue in the read functions, so treat any affected show's per-host numbers as unusable until fixed. Session totals are unaffected. |
| **6** | **the second tab's pick clobbers the first** | **2a regression — the original bug** | **Roll back the extension.** This is the failure that silently misattributes an entire concurrent show, and it is invisible without inspecting segments. Do not continue with two tabs on the old build either — close the second tab and run one live per machine until fixed. |
| 5 | sales attribute to the wrong host | writer or boundary | Finish the show; segments are diagnostic. Rollback after, not during. |
| 7 | segment stays open after the live ends | a close path did not fire | **Not urgent.** `lensed_session_activity_end` bounds an orphan to the last sale — measured, 456.2h of exposure collapses to 5.85h. Finish, then read the ring for `host.segment_close_error`. Keep `SEGMENT_CLOSE_WRITE_ENABLED` off. |
| 8 | conservation fails (`sum(auctions)` ≠ sold count) | attribution is losing or duplicating sales | Finish the show. Determine direction first: **less** than sold count = sales lost to a gap; **more** = an overlap double-counting. The second is worse. Rollback the extension either way before the next show. |
| **9** | **the overlay shows a clean selection for a host that failed** | **spec §10 regression** | **This is not a rollback.** It is a UI gap, not a data bug — the DB correctly refused the write. But it is the failure mode that makes every other failure invisible, so it **blocks distribution to host machines**. Capture the ring, finish the test, fix the indicator, re-run step 9. The indicator is covered by `extension/test/content-host-failure.test.mjs` (38 checks), so a regression here should have failed the suite first — if it did not, the test has a gap too. |

### The distinction that matters

- **Steps 1 and 6 are rollback-now.** A bad build, and the silent-misattribution bug.
- **Steps 3, 4, 5, 7, 8 are finish-then-fix.** The data is additive and diagnostic; ending the
  show early loses information you would want.
- **Step 9 is fix-before-distribution.** No rollback, but a hard gate.

---

# 11. The backfill re-run — exact command

**It is a single idempotent statement.** One `INSERT … SELECT` with a `NOT EXISTS` guard; safe to
run any number of times. Re-running after the writer is live is also safe: the guard is
per-session, so any session that already has a segment is skipped.

Saved verbatim as `supabase/backfill/phase2_backfill_rerun.sql` so nothing has to be composed in
the distribution window.

```bash
psql "$LENSED_DB_URL" -1 -v ON_ERROR_STOP=1 -f supabase/backfill/phase2_backfill_rerun.sql
```

`-1` wraps it in a transaction (the file has no `begin`/`commit` of its own, deliberately — the
106 file does, which is why applying *that* requires dropping `-1`).

Expected output: `INSERT 0 <n>`, where `<n>` was **6** at the time of writing.

### Before

```sql
select count(*) as need_backfill
from public.live_sessions ls
where ls.host_id is not null and ls.started_at is not null
  and not exists (select 1 from public.live_session_host_segments s where s.session_id = ls.id);
```

### After — must be 0

Re-run the same query. If it is not 0, **stop and investigate before distributing**; a non-zero
result means a session has a `host_id` the guard did not cover.

### If you would rather not use psql

The same statement through the Management API:

```bash
RAW=$(security find-generic-password -s "Supabase CLI" -w)
TOKEN=$(echo "${RAW#go-keyring-base64:}" | base64 -d)
python3 -c "import json,sys;print(json.dumps({'query':sys.stdin.read()}))" \
  < supabase/backfill/phase2_backfill_rerun.sql \
  | curl -s -X POST "https://api.supabase.com/v1/projects/dvucodtdojumvplmgjeu/database/query" \
      -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d @-
```
