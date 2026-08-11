-- 078_guard_fresh_tab_closed_end.sql   ⚠️ NOT YET APPLIED — dry-run reported first.
--
-- Defends against a stale / second-MACHINE tab-close ending a LIVE show. Sessions are room-scoped
-- and SHARED across clients, and each client keeps its own in-memory liveTabId, so ANY machine
-- whose extension is on that live can end another host's session when its tab closes. A client-side
-- PATCH filter would only protect UPDATED extension builds (days to redistribute). A BEFORE UPDATE
-- trigger protects EVERY client instantly — including stale builds — and cannot be bypassed.
--
-- RULE: refuse a `tab_closed` end while the heartbeat is FRESH (< 90s). A fresh last_seen_at means
-- the show is live and this tab-close is spurious or foreign, so keep the session live.
--
-- SCOPE — tab_closed ONLY (verified against production data before applying):
--   live_ended      MUST PASS. TikTok's AUTHORITATIVE end arrives while the heartbeat is still
--                   fresh — 36 of 37 real live_ended sessions were fresh-at-end. Guarding it would
--                   strand sessions open forever.
--   auto_ender      Passes for free — it only ever fires on staleness, so a freshness guard never
--                   trips it.
--   manual_recovery Deliberate human action — must always be allowed.
--   (any other / null end_source)  Untouched.

create or replace function public.guard_fresh_tab_closed_end()
returns trigger
language plpgsql
as $$
begin
  if NEW.status = 'ended' and OLD.status = 'live'
     and NEW.end_source is not distinct from 'tab_closed'
     and NEW.last_seen_at is not null
     and NEW.last_seen_at > now() - interval '90 seconds'
  then
    -- Fresh heartbeat: a tab-close must not end a live show. Revert the end-specific columns only
    -- (preserve any other change in the same UPDATE); the session stays live.
    NEW.status     := OLD.status;
    NEW.ended_at   := OLD.ended_at;
    NEW.end_source := OLD.end_source;
    raise notice 'guard_fresh_tab_closed_end: REFUSED tab_closed end of session % — last_seen_at fresh (%.0fs ago)',
      NEW.id, extract(epoch from (now() - NEW.last_seen_at));
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_guard_fresh_tab_closed_end on public.live_sessions;
create trigger trg_guard_fresh_tab_closed_end
  before update on public.live_sessions
  for each row execute function public.guard_fresh_tab_closed_end();
