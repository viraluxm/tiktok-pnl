# Phase 2 — extension writes host segments

**Status:** SPEC ONLY. No code written. Depends on 106 (applied 2026-08-19 23:11:32Z) and 108.

Phase 1 gave the schema a place to record *who was hosting when*. Nothing writes it yet: all 202
segments are `backfill_legacy`, one per session, so the data still says "one host per show."
Phase 2 makes the extension write real segments.

---

## 1. Host dropdown → `open_session_host_segment`

**REPLACE `set_session_host`, do not wrap it.**

`open_session_host_segment` already updates `live_sessions.host_id` itself (that sync was built
into 106 precisely so the nine existing scalar consumers keep working). Calling both would:

- issue two `UPDATE`s to the same scalar from two RPCs, racing each other, and
- leave a path where the scalar moves *without* a segment opening — the exact divergence Phase 2
  exists to remove.

So: `setSelectedHost` (`background.js:1091`) and `maybeApplyHost` (`:1072`) swap their
`supabaseRpc('set_session_host', …)` call for `open_session_host_segment`, passing `p_source`:

| call site | `p_source` |
|---|---|
| `getOrCreateSession` → new session (`background.js:1166`) | `session_create` |
| `getOrCreateSession` → reused session (`:1143`) | `session_reuse` |
| operator changes the dropdown (`onHostChange` → `SET_SESSION_HOST`) | `extension_switch` |
| post-reload re-assert (`tiktok-content.js:2086-2103`, `restoreHostByRoom`) | `session_reuse` |

`maybeApplyHost`'s memo (`hostAppliedForSession`) can stay as a cheap client-side guard, but it is
no longer the correctness mechanism — the RPC's idempotency branch is. Re-asserting the same host
on an already-open segment returns the existing segment id and writes nothing.

**Do NOT drop `set_session_host` from the database.** Older extension builds in the field will keep
calling it, and we cannot force-update every host machine at once. It stays as a compatibility
surface.

**Retirement trigger (new capability):** the `ext_version` stamp shipping in this same build makes
`capture_events.ext_version` populated for the first time. Once it shows no build below the Phase 2
version writing captures, `set_session_host` can be revoked and dropped. That decision was
previously unmakeable — the column was 100% NULL across all 76,673 rows.

---

## 2. Close paths

| trigger | current code | `p_source` |
|---|---|---|
| room change (new live) | `background.js:2067-2077` clears `selectedHostId` | `room_change_close` |
| signed-in user changes | `background.js:1951-1964` clears session + host | **see risk R1** |
| host ends the live (Seller Center end POST) | `background.js:450` | `session_end` |
| tab closed | tab-close path feeding `end_source='tab_closed'` | **see risk R1** |

Implementation note for room change: `close_session_host_segment` needs the **old** session id, so
capture it *before* the reset block nulls `currentSessionId`. Getting this wrong is silent — the
close becomes a no-op on a session id that is already gone.

All closes are **best-effort and non-fatal**: wrapped, logged, never blocking the reset or the end.
A failed close leaves a dangling open segment, which the read path already bounds (§3).

### R1 — `INVALID_SOURCE` will reject two of these

`live_session_host_segments_source_check` has **no catch-all**, and both RPCs re-validate `p_source`
against the same list and `raise exception 'INVALID_SOURCE'`. There is no enum value for a
user-change close or a tab-close. Because closes are best-effort, the exception would be swallowed
and the segment would silently stay open.

This is a deliberate divergence from migration 094's precedent, which chose *no* CHECK so unknown
values from a future extension build stay **recordable, not rejected**. 106 chose strictness.

**Required before Phase 2 ships: migration 110** adding `user_change_close` and `tab_closed` to the
CHECK constraint *and* to the validation list inside both RPCs. Additive, no capture-path lock.
Do not ship the writer against the current vocabulary.

---

## 3. Service-worker eviction with a segment open

Nothing client-side runs, so this is handled in three layers that already exist:

1. **Read path bounds it (shipped in 106).** `lensed_session_activity_end` ceilings an open
   segment at the last sale of the contiguous run, so a dangling segment cannot credit a host
   past the last thing they actually sold. This is why `wind_down_grace = 0` matters.
2. **Recovery is correct by construction.** On SW wake the content script re-asserts
   `SET_SESSION_HOST` (`tiktok-content.js:2086-2103`); the RPC's idempotency branch sees the same
   host on the open segment and returns it untouched. No duplicate, no zero-length segment.
3. **`autoEnd` closes it server-side** (§4).

**Residual, accepted:** if the SW is evicted *and* the cron does not run, the segment stays open
indefinitely. Harmless — bounded by layer 1. Detectable: open segments whose session's
`lensed_session_activity_end` is more than a day old.

---

## 4. `autoEnd.ts` call site

Now worth building: it will have real segments to close. As of the 2026-08-19 dry-run it had none
(the backfill closed all 202 and nothing opens new ones), so a flagged rollout then would have
logged zero events forever and proven nothing.

**Shape** (mirrors `SHIFT_MATERIALIZE_WRITE_ENABLED` / `RESOLVE_CHANNELS_WRITE_ENABLED`):

- Flag: `SEGMENT_CLOSE_WRITE_ENABLED`, default off.
- RPC: `close_session_host_segment_as(owner_user_id, session_id, proposed_ended_at, 'session_end')`
  — the service-role twin from 108, because `autoEnd` runs via `createAdminClient()` where
  `auth.uid()` is NULL.
- Instant: **`proposed_ended_at`, never `now()`.** `autoEnd` already computes it. Passing `now()`
  would credit the host for the idle gap the ender is trimming off.
- Best-effort: per-session `try/catch`, never blocks the session end. Log failures.

**Dry-run that can actually be validated** — extend the existing report with:

```
segmentsWouldClose: [{ session_id, owner_user_id, segment_id,
                       segment_started_at, proposed_ended_at, minutes_open }]
```

Validation gate, in order:

1. Phase 2 writer live for **≥1 full show**.
2. Run the cron dry-run. **`segmentsWouldClose` must be non-empty** — an empty array means the
   writer is not opening segments and the flag must stay off.
3. For each entry, confirm `proposed_ended_at` is within the show window and
   `segment_started_at < proposed_ended_at` (no inverted or zero-length close).
4. Flip `SEGMENT_CLOSE_WRITE_ENABLED=true`.
5. Re-run; confirm the segments actually closed with `ended_source='session_end'`.

`multiLive` sessions get **no** close — they are flagged for manual split, not ended. Their
segments stay open and the read path bounds them.

---

## 5. Pre-Phase-2 backfill re-run — checklist item, not a migration

106's backfill is a one-shot `INSERT … WHERE NOT EXISTS`. Every hosted session created since
**2026-08-19 23:11:32Z** has a `host_id` and no segment. It was 1 session hours later; it grows
with every show.

Re-run the section-D `INSERT` verbatim in the deploy window, **after the last pre-Phase-2 show and
before the first Phase-2 show**. Idempotent by the `not exists` guard.

Ordering matters only for tidiness: the guard is per-session, so a session that already has an
extension-written segment is skipped either way — it can never end up with both a
`backfill_legacy` and a live segment.

---

## 6. One build, one distribution

Per the sequencing decision: **do not distribute for `ext_version` alone.** Merge order:

1. `fix/capture-ext-version` — the 2-line stamp + the capture-row body assertion.
2. The capture-literal dedupe (`buildCaptureRow` / `upsertCaptureEvent`, byte-identical 16-field
   copies). The body assertion from step 1 is what catches a field dropped during the collapse.
3. The Phase 2 segment writer.

One version bump, one zip, one smoke test.

**Blocker before bumping:** the deployed version is still unknown. `manifest.json` says `0.6.4`
while built zips go to `0.6.5`, `ext_version` is NULL for every row ever written (the fix ships
*in* this build, so it cannot help yet), and `ext_diag_events` is empty. Establish the real
deployed version out-of-band — Web Store listing, or have a host read the overlay's diagnostics —
then bump above it. Do not guess.

---

## 7. Smoke test on a real live, before any host machine

**Auth constraint (non-negotiable, CLAUDE.md):** anything that establishes a *different* Supabase
session on a machine replaces the capture JWT and captures silently write under the wrong
`user_id`. So the smoke test runs **under the same owner account hosts use**, on a machine that is
**not** a host's. Never sign a sub-user into lensed.io on a host machine.

Load unpacked on that one controlled machine and, on a real live:

| # | step | assertion |
|---|---|---|
| 1 | let a sale land | new `capture_events` row has non-NULL `ext_version` matching the new manifest |
| 2 | select host A | exactly 1 open segment; `host_id`=A; `source` ∈ {`session_create`,`session_reuse`}; `started_at` ≈ selection; `live_sessions.host_id`=A |
| 3 | 2+ sales | `pnl_show_host_segments` shows A with those auctions, no `Unattributed` row |
| 4 | **switch to host B** | see §8 |
| 5 | 2+ more sales | they attribute to **B**, not A |
| 6 | end the live | B's segment closed, `ended_source='session_end'` |
| 7 | conservation | `sum(auctions)` = session sold count |

**Rollback:** reinstall the previous zip. Segments already written stay — they are additive and
nothing in production reads them yet except the new read functions.

---

## 8. Verifying a mid-show switch produced two segments with correct boundaries

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

- **exactly 2 rows**
- `row1.ended_at = row2.started_at` — `boundary_contiguous` true. No gap (sales would fall into
  `Unattributed`) and no overlap (a sale would double-count).
- `row1.ended_source = 'extension_switch'`, `row2.ended_at is null` while live
- exactly **1** open segment (the partial unique index guarantees it; verify anyway)
- `row1.host_id ≠ row2.host_id`
- neither segment is zero-length (`started_at < ended_at`) — see R2

Then attribution:

- `sum(auctions)` across `pnl_show_host_segments` = the session's sold count, **no `Unattributed`**
- a sale timestamped *before* the boundary → host A; *at or after* → host B (half-open interval)
- **boundary edge case worth forcing:** if a sale lands in the same second as the switch it must
  attribute to **B**, the incoming host. This is the rule the 106 rehearsal off-by-one was about
  — half-open between segments, closed only at the session ceiling.
- `pnl_show_hourly_by_host` splits the switch hour across A and B, and those two rows sum to that
  hour's row in `pnl_show_hourly`.

---

## Open risks

- **R1 — `INVALID_SOURCE`.** Needs migration 110 (§2) before the writer ships. Highest priority.
- **R2 — clock skew.** `p_at` comes from a browser and is clamped server-side to
  `[started_at, now()]`. A host machine with a badly wrong clock gets its switch instant collapsed,
  possibly to a zero-length segment. Detect with `started_at = ended_at`; consider alerting.
- **R3 — the 45-minute contiguity guard fires on 0 of 201 real sessions.** Imported from
  `autoEnd.ts:12 IDLE_THRESHOLD_MIN` and pinned by `src/lib/sessions/sessionEnd.drift.test.mjs`,
  but untested against production data. Phase 2 does not change that; a genuinely long mid-show
  gap would be its first real exercise.
- **R4 — two tabs / two rooms on one machine.** Segments are session-scoped and the unique index is
  per-session, so this is structurally fine, but the extension's single in-memory `selectedHostId`
  is not. Worth an explicit test if any machine ever runs two lives.
- **R5 — `/api/member/team/host-performance` still reads `closed_at`.** The station Team page keeps
  showing the old flattering numbers until a service-role `_as` twin of `pnl_host_performance`
  exists. Unrelated to Phase 2, but it will be visible as a discrepancy between two pages.
