# Post-Live Deploy Checklist — Extension Logout-Race Fix

Ship the single-refresher fix **after the live session ends**. Order matters: **web first**, then extension. The web half is backward-compatible with the old installed extension, so deploying it alone cannot break the running extension.

## Staged (as of prep, all UNCOMMITTED)
- **Web** (`~/Desktop/saas/Lensed`), branch `fix/ext-auth-single-refresher`: `src/hooks/useExtensionAuth.ts` — access-token-only relay + `LENSED_REQUEST_TOKEN` responder.
- **Extension** (`~/Desktop/saas/lensed-extension`), branch `fix/single-refresher`: `background.js` (no independent refresh), `manifest.json` (host perms + bridge content script), new `lensed-bridge.js`.
- **Phase E** store-creation work is parked in `stash@{0}` on `feat/phase-e-store-creation` (separate feature, do NOT ship with this fix).

## Why web-first is safe
- Old installed extension expects `{ accessToken, refreshToken }`. New web build sends `{ accessToken }` only.
- New extension `onMessageExternal` tolerates a missing `refreshToken`; old extension tolerates the missing field too (it did `rt || ''`) — it just stops receiving a *fresh* refresh token, so its stored one ages out. That's acceptable for the short window between the two deploys, and the whole point of the fix is to stop the extension refreshing at all.

---

## Step 1 — Deploy the WEB half first
1. `cd ~/Desktop/saas/Lensed`
2. `git checkout fix/ext-auth-single-refresher`
3. Review: `git diff main -- src/hooks/useExtensionAuth.ts` (should be working-tree changes; commit them).
4. `git add src/hooks/useExtensionAuth.ts && git commit` (see Step 5 for merge).
5. Deploy web (merge to `main` → Vercel, or your normal deploy). **Deploy web BEFORE loading the new extension.**

## Step 2 — Confirm the CURRENT (old) extension still works against new web
- With the new web deployed and the **old** extension still installed:
  - Open lensed.io (logged in) and shop.tiktok.com.
  - Confirm the extension still shows **Connected** and a normal capture still logs (SKU resolve + auction log).
  - This proves the web change didn't break the installed extension. If it did, roll back web before proceeding.

## Step 3 — Load the NEW extension unpacked (only after Step 2 passes)
1. `cd ~/Desktop/saas/lensed-extension`
2. `git checkout fix/single-refresher`
3. Build if applicable: `npm run build` (runs `build.sh` → produces `dist/`; then `node validate-build.mjs dist`). If loading source directly, skip.
4. Chrome → `chrome://extensions` → Developer mode → **Load unpacked** (the `dist/` or repo root). Note the extension ID matches the pinned `key` (`mdfjfepjpnhidnfpeghkpgdjpcjehbpg`).

## Step 4 — Run the 3 tests
1. **Normal capture** — lensed.io + shop.tiktok.com open, logged in. Trigger a sale/scan → SKU resolves, auction logs, no errors in the service-worker console. Confirms push relay + normal auth path.
2. **Token-expiry recovery via bridge** — keep a **lensed.io tab open**. Force the extension's access token to lapse (wait past `jwt_exp` 3600s, or in the SW console clear the in-memory token and let a REST call 401). Next API call should log `access token recovered from web app` and succeed on the retry. Confirms `lensed-bridge.js` ↔ `useExtensionAuth` pull path.
3. **Reconnect state with NO lensed.io tab** — close all lensed.io tabs, keep only shop.tiktok.com, force a 401. Extension must NOT call `/auth/v1/token`; it should enter reconnect state and broadcast `reason: 'expired'` (UI shows "session expired — open lensed.io"). Confirms no independent refresh + graceful degrade.

## Step 5 — Merge both (web-first)
1. Web: merge `fix/ext-auth-single-refresher` → `main` (should already be deployed from Step 1; open PR, merge).
2. Extension: merge `fix/single-refresher` → `main`, then cut/publish the new build (bump `manifest.json` version above `0.2.0`).

## Post-deploy watch
- Watch for logout reports for ~24h. Success = the random logouts on both surfaces stop.
- The 60s `security_refresh_token_reuse_interval` mitigation stays in place; consider whether to revert it to 10s once the single-refresher fix is confirmed (separate decision).

---

## Restore Phase E work later (unrelated feature)
```
cd ~/Desktop/saas/Lensed
git checkout feat/phase-e-store-creation
git stash pop        # restores route.ts + useStores.ts + TikTokConnect.tsx
git stash list       # confirm stash@{0} is gone
```

## Rollback
- **Web**: revert the `main` merge / redeploy previous Vercel build.
- **Extension**: remove the unpacked load and re-load the previous packed build, or revert `main` and rebuild. The old `0.2.0` artifact is still tagged on `main`.

---

# Post-Live Deploy — Recurring-Shift Materialization (`feat/recurring-shift-materialization`)

Freezes past recurring-shift days into real `shifts` rows so deleting/deactivating/editing a rule can't erase worked history. Daily Vercel cron + a pre-mutation freeze on the app side.

## Migration
- **Migration `055_shifts_source_rule_id.sql` is ALREADY APPLIED to prod** (project `dvucodtdojumvplmgjeu`): adds `shifts.source_rule_id` (nullable, FK **ON DELETE SET NULL**) + a unique index (idempotency) + a lookup index. Additive/idempotent — **do NOT re-run manually**; a fresh `db reset`/rebuild re-applies it harmlessly.

## Env vars (Vercel) — REQUIRED before the cron does anything useful
- **`CRON_SECRET`** — must be set (same secret the existing `auto-end-sessions` cron uses). The `/api/cron/materialize-shifts` route rejects any call whose `Authorization: Bearer <CRON_SECRET>` doesn't match. Without it the daily cron is unauthorized and no-ops.
- **`SHIFT_MATERIALIZE_WRITE_ENABLED`** — **leave UNSET (log-only) for the first cron cycle.** In log-only mode the cron computes and logs exactly what it *would* materialize (`[cron/materialize-shifts] WOULD_MATERIALIZE …`) but writes nothing. After reviewing one run's output and confirming the would-materialize set looks right, **set it to `true`** to enable the (additive, idempotent) writes. It writes payroll rows, so the one-look-first ramp is deliberate.

## Verify after enabling writes
- Watch `[cron/materialize-shifts] mode=WRITE … materialized=N` in the cron logs.
- Spot-check: a materialized past day appears as a real `shifts` row with `source_rule_id` set; deleting its rule leaves the row (now `source_rule_id = NULL`). Pay totals must be UNCHANGED by materialization (exactly-once — see `src/lib/employees.materialize.test.mjs`).

## Rollback
- Set `SHIFT_MATERIALIZE_WRITE_ENABLED` unset (back to log-only) to stop writes immediately; the column/FK are additive and safe to leave in place.

---

# Extension Release — build & distribute (part of DONE on any `extension/` PR)

Source-only version bumps are NOT shippable. `dist/` and `lensed-extension-v*.zip` are
**git-ignored build outputs** — merging a PR does NOT rebuild them, so after any change under
`extension/` the release artifact must be rebuilt and distributed by hand. Run this every time.

## Checklist
1. **Bump `extension/manifest.json` `version`** in the PR (a code change with no version bump ships as the old version).
2. After merge, `git checkout main && git pull`. Confirm `grep '"version"' extension/manifest.json` is the new version. *(If not, a merge dropped the bump — stop.)*
3. `cd extension && npm install && npm run build` (`build.sh`: rsync → terser minify → `validate-build.mjs` → zip). A **validation failure fails the build — do not distribute.**
4. **Verify BOTH built manifests match source**, since `dist/` is a stale-prone local dir:
   - `grep '"version"' extension/dist/manifest.json`
   - `unzip -p extension/lensed-extension-v<version>.zip manifest.json | grep '"version"'`
   Both MUST equal the source version. (A stale `dist/` at the old version is the classic failure.)
5. **Distribute** `lensed-extension-v<version>.zip` to host machines (it is git-ignored — attach to a GitHub Release or share directly; do NOT assume `git pull` delivers it).
6. Confirm each host **removes the old unpacked extension and loads the freshly-unzipped folder** (see extension/README "Load unpacked"). Loading a stale `extension/dist/` is the other classic failure.

## Known gap (unverifiable rollout)
The DB carries **no extension-version field** — `EXT_VERSION` lives only in local diagnostics, never written to `capture_events`/sessions. So "every host is on v<version>" cannot be confirmed from data. Fix: stamp `EXT_VERSION` into the capture write, then query the per-host version distribution.
