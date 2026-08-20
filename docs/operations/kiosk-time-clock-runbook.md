# Kiosk time clock — operations runbook

The badge-scan time clock runs as a dedicated Supabase login account
(`app_metadata.role = 'timeclock'`) on a tablet on the warehouse floor. The
**primary control is physical**: the tablet lives in a locking mount within view
of a camera. The levers below are the software backstops for locking it,
revoking it, and disabling punches under pressure — findable here rather than
buried in a chat.

Middleware confines a `timeclock` session to `/kiosk` + `/api/kiosk/*` only, so a
walked tablet **cannot** reach order data, admin, payroll, or `/s/[token]`. The
blast radius is *punching*, not data. That is why none of the below is a
five-alarm fire — but do it anyway when a tablet goes missing.

## Station scanner (confirmed 2026-08-16 — do not re-litigate)

**Hardware: Tera 9700 — 2D area imager, hands-free presentation stand. Reads
both 1D (Code 128 badges) and 2D (phone-screen QR).**

Consequence: the **rotating-QR path (096) is GO** — it works on this scanner with
no hardware change. All 15 team members clock in on **phone QR as the default**
path; the printed Code 128 badge stays as the logged **fallback** for a dead
phone / cracked camera / no wifi / dim screen. (2D imagers read phone screens
fine; the laser-scanner caveat in the QR spec does not apply to this station.)

## Levers, fastest first

### 1. Disable ALL punching immediately (no auth change)
Use when a tablet has walked or you suspect abuse and want punching to stop
**now**, before dealing with the session.

Revoke the owner's active kiosk token — every `/api/kiosk/*` scan then returns
"This kiosk is not configured" (`resolveKioskToken` → `null`). The session may
stay alive but can no longer punch.

In **`/admin/badges`**, click **Disable kiosk**. Re-enable with **Enable kiosk**,
which mints a FRESH token (rotate-on-re-enable — any previously cached token is dead).

### 2. Kill the tablet's SESSION (walked and unreachable)
The kiosk account's session auto-refreshes and does **not** expire on its own, so
disabling the token (lever 1) does not end the session. To revoke it
server-side, **ban the timeclock auth user** — this invalidates its refresh
tokens:

In **`/admin/badges`** → **Kill session (ban + rotate)**: bans the timeclock account
(revokes its refresh tokens) and rotates its password, shown once. **Rotate password**
and **Unban** are always available there, so a missed reveal can never brick the kiosk.
(Studio equivalent: Authentication → Users → the kiosk account → Ban, then reset password.)

Access tokens are short-lived (~1h) and expire on their own; the ban is the immediate
kill of the refresh loop. **Unban** + **Rotate password** to bring the kiosk back.

### 3. Lock the tablet in-hand (routine)
On the kiosk screen: **Lock** → a supervisor (the store owner) enters their
password → the kiosk account is signed out and returns to `/login`. This is the
end-of-use lock and requires the physical tablet — not an emergency revoke.

## After any revoke
- **Re-provision:** sign the tablet back in as the timeclock account and confirm
  the token is active (`/admin/badges` → "Kiosk: enabled").
- **Audit the window:** badge punches are low-assurance (a printed badge can be
  photographed and reprinted — entropy stops guessing, not copying). Spot-check
  punches during the incident window against the schedule and the camera.

## Badge codes are secrets — never paste them into chat, logs, or tickets
A badge code is a bearer credential: anyone who has the string can print it and
punch as that employee (entropy stops guessing, not copy-and-reprint). So a code
must **never** be pasted into a chat, log line, ticket, screenshot, or email. If one
leaks, the remedy is **reissue**: revoke the badge in `/admin/badges` and issue a new
one (the old code is never reused — the global-unique constraint bars it). A revoked
code is provably dead — scanning it returns `BADGE_NOT_FOUND` with no write.

## Two ways to clock in — and what each one checks (read this at 2am)

There are **two independent clock-in paths**, and they gate differently. Confusing
them is the single most likely 2am mistake, so:

> **The rule:** the schedule gates the **QR path**, not the **badge path**. An
> unscheduled worker with an active badge clocks in **normally** on the kiosk — the
> schedule/punch mismatch surfaces at **payroll reconciliation**, never at punch time.

### Badge scan is schedule-blind — it does NOT check the shift window
A badge scan (`/api/kiosk/scan` → `lensed_kiosk_scan`, migration 091) checks only:
the **kiosk is unlocked** (an active kiosk token) and the **badge is active for an
active employee**. It then acts purely on the worker's *punch state* (clocked-out →
clock in, on-break → end break, etc.) with a 60s rescan guard. It **never** looks at
`shift_instances`, `starts_at`/`ends_at`, or any schedule window.

Consequences a supervisor must know:
- **An early arrival scans normally.** Being 45m (or 3h) before start is irrelevant —
  badge doesn't read the schedule.
- **An UNSCHEDULED worker with an active badge also punches in normally.** No shift
  needs to exist; no password is needed per punch. The badge path does not know or
  care whether the worker is on today's schedule. (The schedule only matters *later*,
  when payroll reconciles punches against it — never at the moment of the punch.)
- The **owner/supervisor password** gates **unlocking the kiosk** (lever 3 above) and
  killing/rotating the session — **not** individual clock-ins. Once the kiosk is
  unlocked, every active badge works without further approval.

So the rule "an unscheduled worker needs the shift added or a password" is **only true
of the QR self-service path below** — it is **not** true of badge scan.

### QR self-service (the `/s/[token]` phone path) IS schedule-bound
The rotating-QR button on the worker's phone page only exists for **their own
`shift_instance`**, and only when now is within **[start − 45m, end + 60m]**. The issue
endpoint (`POST /s/[token]/clock`) re-validates that window **fresh against the DB on
every call** (`out_of_window` → 409; not-their-shift → 403). An **unscheduled** worker
has no `shift_instance`, so there is **no QR button and no way to mint a code** — for
them the remedy is **add the shift** (or fall back to the **badge**, which doesn't
care). There is **no owner-password override on the QR path.**

## Papercut: a shift added mid-day does NOT self-appear on an already-open phone page

The worker's `/s/[token]` page is a **server-rendered snapshot taken at page load**
(`getMyShifts` + `now()` resolved once on the server; `export const dynamic =
'force-dynamic'`). The page's background poll (every 3s) only refreshes *clock state*
for a control that is **already on screen**; it does **not** re-fetch the shift list or
re-evaluate the clock window for **newly added** shifts. A `router.refresh()` fires only
**after a punch confirms** — never proactively.

Therefore, if a supervisor adds a `shift_instance` **after** the worker already opened
`/s/[token]`, the clock button will **not appear on its own**. The worker must **manually
reload the page** (pull-to-refresh / reopen the link). **Nobody is prompted to do this** —
it's a real papercut. The good news: once reloaded, there is **zero further lag** — if now
is inside the window the button renders immediately, because the issue endpoint re-derives
the window fresh from the DB.

Fast mitigations at 2am, in order:
1. **Have the worker reload `/s/[token]`** (fixes it instantly once the shift exists).
2. Or just **badge them in** — the badge path is schedule-blind and needs no reload,
   no shift, and no per-punch password.

(The station kiosk's own ~1/min window-state poll self-heals on the *kiosk* side; this
papercut is specifically the *worker's phone page*, which does not poll the shift list.)

## Known follow-ups (not in the foundation)
- Idle auto-lock on the kiosk (a separate PR).
- Rotating-QR clock-in (single-use, window-scoped) becomes the default path;
  the badge stays permanently as the logged fallback. Scanner confirmed
  compatible (see "Station scanner" above) — QR path is GO.
