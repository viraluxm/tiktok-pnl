-- 202608161754_revoke_anon_write_rpcs.sql
--
-- SECURITY FIX — remove `anon` (unauthenticated) EXECUTE from three SECURITY DEFINER
-- write RPCs. These anon grants are OUT-OF-REPO DRIFT: they were applied to the live DB
-- by hand (Management API/dashboard) and are recorded by NO migration in any worktree.
-- They contradict the documented design — 045 states of lensed_add_batch_admin:
--   "Service-role only: NOT granted to `authenticated`. Reached solely via the ViewTrack
--    integration endpoint using the service role key."
-- and 045/046 `revoke all ... from public` + `from authenticated`, never granting anon.
--
-- IN-REPO CALLERS ARE service_role — revoking anon does not affect them:
--   • lensed_add_batch_admin / lensed_void_batch — invoked via createAdminClient() (service_role)
--     inside src/app/api/integrations/viewtrack/skus/[id]/batches[/void]. ViewTrack authenticates
--     to that HTTP endpoint with a Bearer shared secret (assertViewTrackAuth), NOT a Supabase key.
--   • lensed_reconcile_time_clock — invoked via createAdminClient() (service_role) inside
--     src/app/api/cron/reconcile-time-clock, gated by CRON_SECRET.
--
-- GRANTS ONLY — no function body is altered. service_role and postgres grants are left intact.
-- Follows the kiosk service-role-only pattern (092/095). A REVOKE takes an instant lock and
-- rewrites nothing; none of these three is on the capture/order-sync path.
--
-- Idempotent: REVOKE of an absent privilege is a no-op.

-- lensed_add_batch_admin — live ACL {postgres, anon, service_role}: explicit anon, no PUBLIC,
-- no authenticated. Remove anon only.
revoke execute on function public.lensed_add_batch_admin(uuid, uuid, int, int, text, uuid) from anon;

-- lensed_void_batch — live ACL {postgres, anon, service_role}: same shape. Remove anon only.
revoke execute on function public.lensed_void_batch(uuid, uuid) from anon;

-- lensed_reconcile_time_clock — live ACL {PUBLIC, postgres, anon, authenticated, service_role}.
-- anon is reachable BOTH explicitly AND via PUBLIC, so revoke all three unauthenticated/user roles.
revoke execute on function public.lensed_reconcile_time_clock(integer) from anon;
revoke execute on function public.lensed_reconcile_time_clock(integer) from authenticated;
revoke execute on function public.lensed_reconcile_time_clock(integer) from public;
