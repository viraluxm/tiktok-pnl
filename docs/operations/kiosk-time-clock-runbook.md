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

## Levers, fastest first

### 1. Disable ALL punching immediately (no auth change)
Use when a tablet has walked or you suspect abuse and want punching to stop
**now**, before dealing with the session.

Revoke the owner's active kiosk token — every `/api/kiosk/*` scan then returns
"This kiosk is not configured" (`resolveKioskToken` → `null`). The session may
stay alive but can no longer punch.

There is currently **no in-app disable toggle** (the `/admin/badges` "Enable
kiosk" button only *creates* a token). Disable via SQL with the service role:

```sql
update public.kiosk_tokens set active = false
 where user_id = '<owner_user_id>' and active;
```

Re-enable later with the "Enable kiosk" button (or set `active = true`).

### 2. Kill the tablet's SESSION (walked and unreachable)
The kiosk account's session auto-refreshes and does **not** expire on its own, so
disabling the token (lever 1) does not end the session. To revoke it
server-side, **ban the timeclock auth user** — this invalidates its refresh
tokens:

- Supabase Studio → Authentication → Users → the kiosk account → **Ban user**, or
- Admin API: `supabase.auth.admin.updateUserById(id, { ban_duration: '876000h' })`

Then **rotate its password** so it cannot log back in. Access tokens are
short-lived (~1h) and expire on their own; the ban is the immediate kill of the
refresh loop. Unban + reset the password to bring the kiosk back.

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

## Known follow-ups (not in the foundation)
- Idle auto-lock on the kiosk (a separate PR).
- An in-app "disable kiosk" toggle so lever 1 doesn't require SQL.
- Rotating-QR clock-in (single-use, window-scoped) becomes the default path;
  the badge stays permanently as the logged fallback.
