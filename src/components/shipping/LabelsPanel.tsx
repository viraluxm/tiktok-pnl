'use client';

/**
 * LabelsPanel — buy a day's (or a show's) shipping labels in one act, then print them split into
 * the piles they are packed from.
 *
 * THE SHAPE IS A SAFETY DECISION, not a style one. Buying a label is irreversible: TikTok's
 * Create Packages call IS the purchase, there is no quote and no cancel.
 *
 *   1. SCOPE FIRST. A run means a definite set of work — a fulfilment day, or named shows — not
 *      "everything outstanding". Scope is what bounds the run.
 *   2. CHECK, THEN AUTHORISE. Nothing is bought until a check has been read: authorising passes
 *      back the box count that check reported, and a mismatch refuses. Change the scope and the
 *      reviewed plan is discarded.
 *   3. APPROVAL HAPPENS ONCE. Authorising writes the whole manifest and buys nothing; the drain
 *      then works through it. A day is 474-863 boxes and about ten minutes of calls, so it must
 *      be chunked — but chunking the APPROVAL would be the "multiple batches" this exists to
 *      avoid, so the chunking is internal and invisible.
 *   4. THE COST IS ON THE BUTTON, before it is spent.
 *   5. UNBOUND ORDERS BLOCK BY DEFAULT — waiting is pre-selected, because the team binds shortly
 *      after a show and waiting is nearly always right.
 */

import { useCallback, useEffect, useState } from 'react';
import { useStores } from '@/hooks/useStores';

/** Boxes per drain request. ~50 calls sits well inside the route's time budget. */
const DRAIN_CHUNK = 50;

type UnboundChoice = 'wait' | 'skip' | 'include';
type ScopeKind = 'day' | 'lives';

interface DayScope {
  day: string; boxes: number; ready: number; orders: number;
  /** Held orders whose show is broadcasting right now. */
  heldLiveNow: number;
  /** Held orders from a show that ended, but whose combine window is still open. */
  heldRecent: number;
}
interface LiveScope {
  id: string; channel: string | null; started_at: string | null; ended_at: string | null;
  running: boolean; day: string | null; boxes: number; ready: number; orders: number;
}
interface Scopes { today: string; total_boxes: number; total_ready: number; days: DayScope[]; lives: LiveScope[] }

interface SpendWindows {
  run_total: number;
  last_7d: { labels: number; spent: number };
  last_30d: { labels: number; spent: number };
}
interface DryRun {
  scope: string;
  counts: {
    excluded_too_recent: number; min_order_age_hours: number;
    boxes: number; orders: number; batched_boxes: number; bundle_boxes: number;
    orders_in_scope: number; orders_pulled_in: number; pulled_in_by_day: Record<string, number>;
    not_verified_over_cap: number;
    sku_batches: number; unbound_boxes: number; already_in_ledger: number; would_buy: number;
  };
  spend_estimate: {
    boxes: number; total: number; low: number; high: number; basis: string; samples: number;
  };
  spend_recent: SpendWindows;
  confirm_boxes: number;
  /**
   * The boxes this check is proposing, in print order. POSTed back to /authorize as the
   * approval itself: only boxes in this list may be bought, so a box that appears between the
   * check and the click is left for the next run instead of blocking this one.
   */
  reviewed_keys: string[];
  batches: Array<{ slip: string; boxes: number }>;
}
interface Progress { total: number; bought: number; failed: number; spent: number; done: boolean }
interface RunRow {
  run_id: string; scope: string | null; at: string | null; store_id: string | null;
  labels: number; purchased: number; claimed: number; failed: number;
  singles: number; mixed: number; unbound: number; spent: number; printable: number;
  printed: number;
  failures?: Array<{ orders: string[]; code: string | null; reason: string | null }>;
}

const money = (n: number) => `$${n.toFixed(2)}`;
const fmtDay = (d: string) => new Date(`${d}T12:00:00Z`)
  .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const fmtTime = (iso: string | null) => (iso
  ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles' })
  : '?');

export default function LabelsPanel() {
  const { data: storesData } = useStores();
  const activeStore = storesData?.activeStore ?? 'all';
  const storeName = storesData?.stores?.find((s) => s.id === activeStore)?.name ?? 'this store';

  const [scopes, setScopes] = useState<Scopes | null>(null);
  const [scopeKind, setScopeKind] = useState<ScopeKind>('day');
  const [days, setDays] = useState<Set<string>>(new Set());
  const [lives, setLives] = useState<Set<string>>(new Set());
  const [unbound, setUnbound] = useState<UnboundChoice>('wait');

  const [loadingScopes, setLoadingScopes] = useState(false);
  const [checking, setChecking] = useState(false);
  const [plan, setPlan] = useState<DryRun | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [buying, setBuying] = useState(false);
  /**
   * Buy is a two-step, IN-PAGE confirmation — never window.confirm.
   *
   * The browser decides whether a native dialog appears at all. Measured here: confirm()
   * returned false instantly without rendering, so the button silently did nothing and read as
   * broken. The other failure is worse — a browser that suppresses the dialog by returning true
   * would have spent $2,259 with no confirmation whatsoever. A last line of defence before an
   * irreversible purchase cannot be something the page does not control.
   */
  const [armed, setArmed] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [history, setHistory] = useState<RunRow[] | null>(null);
  const [historyTotal, setHistoryTotal] = useState(0);
  /**
   * Runs ticked for a combined print. May span shops — that is the point.
   *
   * There is no "combine these" mode to switch on: ticking runs IS the gesture, and the history
   * always lists every shop. An earlier version gated both behind one checkbox, which conflated
   * "show me other shops" with "let me combine" and hid the shop name until it was on.
   */
  const [picked, setPicked] = useState<Set<string>>(new Set());

  /** Any change to what would be bought discards the reviewed plan — never buy an unread plan. */
  const invalidate = useCallback(() => {
    setPlan(null); setRunId(null); setProgress(null); setArmed(false);
  }, []);

  const loadHistory = useCallback(async () => {
    try {
      // Always every shop: a stack is printable whatever shop bought it, and the spend record
      // is more use whole than sliced by whichever shop happens to be selected.
      const r = await fetch('/api/shipping/labels/runs');
      if (!r.ok) { setHistory(null); return; }
      const j = await r.json();
      setHistory(j.runs ?? []);
      setHistoryTotal(j.total_spent ?? 0);
    } catch { setHistory(null); }
  }, []);

  useEffect(() => { void loadHistory(); }, [loadHistory]);

  const scopeParams = useCallback(() => {
    const p = new URLSearchParams({ store_id: activeStore });
    if (scopeKind === 'day' && days.size) p.set('day', [...days].sort().join(','));
    if (scopeKind === 'lives' && lives.size) p.set('session_ids', [...lives].join(','));
    return p;
  }, [activeStore, scopeKind, days, lives]);

  // ── Scope options ──
  useEffect(() => {
    if (activeStore === 'all') { setScopes(null); return; }
    let cancelled = false;
    setLoadingScopes(true); setErr(null); invalidate();
    fetch(`/api/shipping/labels/scopes?store_id=${encodeURIComponent(activeStore)}`)
      .then(async (r) => {
        const j = await r.json();
        if (cancelled) return;
        if (!r.ok) { setScopes(null); setErr(j.error ?? 'Could not load shows'); return; }
        setScopes(j as Scopes);
        // Default to the most recent day that has anything ready, which is nearly always the
        // one being printed. Never auto-select a scope with nothing in it.
        const first = (j.days as DayScope[]).find((d) => d.ready > 0) ?? (j.days as DayScope[])[0];
        setDays(first ? new Set([first.day]) : new Set());
      })
      .catch(() => { if (!cancelled) { setScopes(null); setErr('Could not load shows'); } })
      .finally(() => { if (!cancelled) setLoadingScopes(false); });
    return () => { cancelled = true; };
  }, [activeStore, invalidate]);

  const scopeChosen = scopeKind === 'day' ? days.size > 0 : lives.size > 0;

  async function check() {
    if (!scopeChosen) return;
    setChecking(true); setErr(null); setProgress(null); setRunId(null);
    try {
      const p = scopeParams();
      if (unbound === 'include') p.set('unbound', 'include');
      const res = await fetch(`/api/shipping/labels/dry-run?${p.toString()}`);
      const j = await res.json();
      if (!res.ok) { setPlan(null); setErr(j.error ?? `Check failed (${res.status})`); return; }
      setPlan(j as DryRun);
    } catch (e) {
      setPlan(null);
      setErr(`Check failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally { setChecking(false); }
  }

  /**
   * Authorise, then drain to completion.
   *
   * One click. The loop is internal because the approval is not: authorising claims the whole
   * manifest, and each drain request only turns claims into labels.
   */

  /**
   * Work through an authorised manifest until it is empty.
   *
   * Separate from buy() so an interrupted run can be picked up again. A day is ~23 minutes of
   * calls, and a closed tab used to strand the manifest as claimed rows with nothing in the UI
   * offering to continue — the labels were safe but invisible.
   */
  const drain = useCallback(async (
    id: string, total: number, startBought = 0, startFailed = 0, startSpent = 0,
  ) => {
    setRunId(id);
    setProgress({ total, bought: startBought, failed: startFailed, spent: startSpent, done: false });
    let bought = startBought, failed = startFailed, spent = startSpent, guard = 0;
    for (;;) {
      if (guard++ > Math.ceil(total / DRAIN_CHUNK) + 20) {
        setErr('Drain stopped making progress — re-open this tab to resume the run'); break;
      }
      const dp = new URLSearchParams({ store_id: activeStore, run_id: id, limit: String(DRAIN_CHUNK) });
      const dRes = await fetch(`/api/shipping/labels/purchase?${dp.toString()}`, { method: 'POST' });
      const d = await dRes.json();
      if (!dRes.ok) { setErr(d.error ?? `Purchase failed (${dRes.status})`); break; }
      if (d.code === 'disabled') { setErr(d.reason); break; }
      bought += d.purchased ?? 0; failed += d.failed ?? 0; spent += d.spent ?? 0;
      setProgress({ total, bought, failed, spent: Math.round(spent * 100) / 100, done: !!d.done });
      if (d.done) break;
      if ((d.purchased ?? 0) === 0 && (d.failed ?? 0) === 0) {
        setErr('Nothing left to buy in this run'); break;
      }
    }
    void loadHistory();
  }, [activeStore, loadHistory]);

  async function buy() {
    if (!plan) return;
    const n = plan.counts.would_buy;
    setArmed(false);
    setBuying(true); setErr(null);
    try {
      const ap = scopeParams();
      if (plan.counts.unbound_boxes > 0) ap.set('unbound', unbound === 'include' ? 'include' : 'skip');
      // The reviewed set travels in the BODY: ~35KB of group keys for a 1,300-box night, past
      // what a query string carries.
      const aRes = await fetch(`/api/shipping/labels/authorize?${ap.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reviewed_keys: plan.reviewed_keys ?? [] }),
      });
      const aJson = await aRes.json();
      if (!aJson.authorized || !aJson.run_id) {
        setErr(aJson.reason ?? aJson.error ?? `Could not authorise (${aRes.status})`);
        return;
      }
      const id = aJson.run_id as string;
      setRunId(id);
      const total = (aJson.claimed as number) || n;
      // Say so when the plan moved under us. Neither is a problem — the spend is bounded by
      // what was reviewed — but silently buying a different number than the button promised
      // would look like a bug.
      const drifted: string[] = [];
      if (aJson.dropped_since_review > 0) {
        drifted.push(`${aJson.dropped_since_review} of the boxes you approved no longer needed buying`);
      }
      if (aJson.added_since_review > 0) {
        drifted.push(`${aJson.added_since_review} new box(es) appeared and were left for the next run`);
      }
      if (drifted.length) setErr(`Bought ${total} of ${n}: ${drifted.join('; ')}.`);
      await drain(id, total, 0, 0, 0);
      setPlan(null);
      void loadHistory();
    } catch (e) {
      setErr(`Purchase interrupted: ${e instanceof Error ? e.message : String(e)}. `
        + 'Nothing is lost — re-check to see what remains.');
    } finally { setBuying(false); }
  }

  async function release() {
    if (!runId) return;
    const p = new URLSearchParams({ store_id: activeStore, run_id: runId });
    const res = await fetch(`/api/shipping/labels/authorize?${p.toString()}`, { method: 'DELETE' });
    const j = await res.json();
    setErr(res.ok ? `Released ${j.released} unbought box(es).` : (j.error ?? 'Release failed'));
    invalidate();
  }

  if (activeStore === 'all') {
    return (
      <div className="rounded-lg border border-tt-border p-6 text-sm text-tt-muted">
        Pick a specific shop above to buy labels — each shop is a separate TikTok connection.
        Printing is not restricted that way: any shop&rsquo;s history lists every run, and
        ticking several prints them as one stack.
      </div>
    );
  }

  const unboundCount = plan?.counts.unbound_boxes ?? 0;
  const blocked = unboundCount > 0 && unbound === 'wait';
  const n = plan?.counts.would_buy ?? 0;
  const est = plan?.spend_estimate;
  // Per-box average implied by the sized estimate, for the "about $X each" line only.
  const unit = est && est.boxes ? est.total / est.boxes : 0;

  return (
    <div className="space-y-4">
      {/* ── 1 · Scope ──────────────────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-tt-border p-4">
        <h3 className="text-sm font-semibold text-tt-text">1 · What are you printing?</h3>
        {loadingScopes && <p className="mt-2 text-xs text-tt-muted">Loading shows…</p>}

        {scopes && (
          <>
            <div className="mt-3 flex gap-1">
              {(['day', 'lives'] as ScopeKind[]).map((k) => (
                <button
                  key={k}
                  onClick={() => { setScopeKind(k); invalidate(); }}
                  className={`cursor-pointer rounded-md border px-3 py-1.5 text-sm ${
                    scopeKind === k ? 'border-tt-green text-tt-text' : 'border-tt-border text-tt-muted hover:text-tt-text'
                  }`}
                >
                  {k === 'day' ? 'A whole day' : 'Specific shows'}
                </button>
              ))}
            </div>

            {scopeKind === 'day' && (
              <DayCalendar
                days={scopes.days}
                today={scopes.today}
                selected={days}
                onToggle={(d) => {
                  setDays((prev) => {
                    const next = new Set(prev);
                    if (next.has(d)) next.delete(d); else next.add(d);
                    return next;
                  });
                  invalidate();
                }}
              />
            )}

            {scopeKind === 'lives' && (
              <div className="mt-3 max-h-72 space-y-1 overflow-y-auto rounded-md border border-tt-border p-2">
                {scopes.lives.length === 0 && (
                  <p className="p-2 text-xs text-tt-muted">No shows with unbought labels.</p>
                )}
                {scopes.lives.map((l) => (
                  <label key={l.id} className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 hover:bg-tt-card">
                    <input
                      type="checkbox" checked={lives.has(l.id)}
                      onChange={(e) => {
                        setLives((prev) => {
                          const next = new Set(prev);
                          if (e.target.checked) next.add(l.id); else next.delete(l.id);
                          return next;
                        });
                        invalidate();
                      }}
                      className="mt-1 cursor-pointer"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="text-sm text-tt-text">
                        {l.channel ?? 'Unknown channel'}
                        {l.running && <span className="ml-2 text-xs text-tt-yellow">· live now</span>}
                      </span>
                      <span className="block text-xs text-tt-muted">
                        {l.day ? fmtDay(l.day) : '?'}, {fmtTime(l.started_at)}–{fmtTime(l.ended_at)}
                        {' · '}{l.ready} ready{l.ready !== l.boxes ? ` of ${l.boxes}` : ''}
                        {' · '}{l.orders} orders
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            )}

            <button
              onClick={check}
              disabled={!scopeChosen || checking || buying}
              className="mt-3 cursor-pointer rounded-md bg-tt-green px-4 py-2 text-sm font-medium text-black disabled:cursor-not-allowed disabled:opacity-40"
            >
              {checking ? 'Checking against TikTok…' : plan ? 'Re-check' : 'Check what’s ready'}
            </button>
          </>
        )}
      </div>

      {/* ── 2 · What the check found ───────────────────────────────────────────────── */}
      {plan && (
        <div className="rounded-lg border border-tt-border p-4">
          <h3 className="text-sm font-semibold text-tt-text">2 · {plan.scope}</h3>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Labels to buy" value={n} big />
            <Stat label="Orders covered" value={plan.counts.orders} />
            <Stat label="Singles (prep station)" value={plan.counts.batched_boxes} />
            <Stat label="Mixed" value={plan.counts.bundle_boxes} />
          </div>
          {plan.counts.orders_pulled_in > 0 && (
            /* Reconciles against Seller Center, which counts only the orders placed that night.
               Without this the totals differ and it reads as Lensed being wrong. */
            <p className="mt-3 rounded-md bg-tt-card px-3 py-2 text-xs text-tt-muted">
              <span className="text-tt-text">{plan.counts.orders_in_scope.toLocaleString()}</span>
              {' '}of those orders were placed on the night you picked. The other{' '}
              <span className="text-tt-text">{plan.counts.orders_pulled_in.toLocaleString()}</span>
              {' '}come from{' '}
              {Object.entries(plan.counts.pulled_in_by_day)
                .sort()
                .map(([d, n]) => `${fmtDay(d)} (${n})`)
                .join(', ')}
              {' '}— they share a combine box with one of this night&rsquo;s orders, and a box is
              always bought whole so no label covers half a parcel. Buying this night will reduce
              those nights too.
            </p>
          )}
          {plan.counts.not_verified_over_cap > 0 && (
            /* A truncated check must never look like a complete one. Without this the plan
               silently under-reports and the operator buys less than they meant to. */
            <p className="mt-3 rounded-md border border-tt-yellow/40 bg-tt-yellow/5 px-3 py-2 text-xs text-tt-yellow">
              <span className="font-semibold">
                This check is incomplete — {plan.counts.not_verified_over_cap} more box
                {plan.counts.not_verified_over_cap === 1 ? '' : 'es'} could not be verified in time.
              </span>{' '}
              <span className="text-tt-muted">
                They are NOT in the count above and will not be bought. Narrow the scope to fewer
                nights, buy this batch and check again, or just re-check — it often completes on
                a second pass.
              </span>
            </p>
          )}
          {plan.counts.excluded_too_recent > 0 && (
            <p className="mt-3 rounded-md bg-tt-card px-3 py-2 text-xs text-tt-muted">
              {plan.counts.excluded_too_recent} box(es) held back — newer than{' '}
              {plan.counts.min_order_age_hours}h, so their combine group may still be growing.
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-x-6 gap-y-1 rounded-md bg-tt-card px-3 py-2 text-xs text-tt-muted">
            <span>Last 7 days: <span className="text-tt-text">{money(plan.spend_recent.last_7d.spent)}</span> · {plan.spend_recent.last_7d.labels} labels</span>
            <span>Last 30 days: <span className="text-tt-text">{money(plan.spend_recent.last_30d.spent)}</span> · {plan.spend_recent.last_30d.labels} labels</span>
            <span>Average label: <span className="text-tt-text">{money(unit)}</span></span>
          </div>
          {plan.batches.length > 0 && (
            <details className="mt-3 rounded-md border border-tt-border">
              <summary className="cursor-pointer px-3 py-2 text-xs text-tt-muted">
                {plan.counts.sku_batches} SKU section{plan.counts.sku_batches === 1 ? '' : 's'} in the singles pile
              </summary>
              <ul className="border-t border-tt-border px-3 py-2 text-xs">
                {plan.batches.map((b) => (
                  <li key={b.slip} className="flex justify-between py-0.5">
                    <span className="text-tt-text">{b.slip}</span>
                    <span className="text-tt-muted">{b.boxes}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {/* ── Unbound ────────────────────────────────────────────────────────────────── */}
      {plan && unboundCount > 0 && (
        <div className="rounded-lg border border-tt-yellow/40 bg-tt-yellow/5 p-4">
          <h3 className="text-sm font-semibold text-tt-text">
            {unboundCount} box{unboundCount === 1 ? '' : 'es'} have no SKU on file
          </h3>
          <p className="mt-1 text-xs text-tt-muted">
            Usually the show ended recently and binding hasn&rsquo;t caught up.
          </p>
          <div className="mt-3 space-y-2">
            <Radio checked={unbound === 'wait'} onChange={() => setUnbound('wait')}
              label="Wait — bind them, then re-check"
              hint="Recommended. Nothing is bought while this is selected." />
            <Radio checked={unbound === 'skip'} onChange={() => setUnbound('skip')}
              label="Continue without them"
              hint="Buys the rest. These wait for a later run." />
            <Radio checked={unbound === 'include'} onChange={() => { setUnbound('include'); invalidate(); }}
              label="Buy them too"
              hint="Their labels say nothing about contents — the picker must look each order up. Re-check required." />
          </div>
        </div>
      )}

      {/* ── 3 · Buy ────────────────────────────────────────────────────────────────── */}
      {plan && n > 0 && !progress && (
        <div className="rounded-lg border border-tt-border p-4">
          <h3 className="text-sm font-semibold text-tt-text">3 · Buy them</h3>
          <p className="mt-1 text-xs text-tt-muted">
            {blocked
              ? 'Answer the unbound question above first.'
              : `One go. Roughly ${Math.max(1, Math.round(n / 60))} minute${n > 90 ? 's' : ''} of TikTok calls — leave this tab open.`}
          </p>

          {!armed ? (
            <button
              onClick={() => setArmed(true)}
              disabled={blocked || buying}
              className="mt-3 cursor-pointer rounded-md bg-tt-green px-4 py-2 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40"
            >
              Buy {n} label{n === 1 ? '' : 's'} — about {money(est?.total ?? 0)}
            </button>
          ) : (
            /* Confirmation lives in the page, not in a browser dialog — see `armed`. */
            <div className="mt-3 rounded-md border border-tt-yellow/50 bg-tt-yellow/5 p-3">
              <p className="text-sm font-semibold text-tt-text">
                Buy {n} label{n === 1 ? '' : 's'} for {storeName}?
              </p>
              <ul className="mt-2 space-y-0.5 text-xs text-tt-muted">
                <li>Scope: {plan.scope}</li>
                <li>
                  Estimated <span className="text-tt-text">{money(est?.total ?? 0)}</span>
                  {est && est.high > est.low && (
                    <> — this mix has cost between {money(est.low)} and {money(est.high)}</>
                  )}
                </li>
                <li>
                  About {money(unit)} a label. Bigger combine boxes cost more, so the estimate
                  moves with the mix{est?.basis === 'fallback' ? ' and has no history behind it yet' : ''}.
                </li>
                <li className="text-tt-yellow">
                  Not a quote — TikTok only prices a label by charging for it. This cannot be undone.
                </li>
              </ul>
              <div className="mt-3 flex gap-2">
                <button
                  onClick={buy}
                  disabled={buying}
                  className="cursor-pointer rounded-md bg-tt-green px-4 py-2 text-sm font-semibold text-black disabled:opacity-40"
                >
                  {buying ? 'Buying…' : `Yes — buy ${n}, about ${money(est?.total ?? 0)}`}
                </button>
                <button
                  onClick={() => setArmed(false)}
                  disabled={buying}
                  className="cursor-pointer rounded-md border border-tt-border px-4 py-2 text-sm text-tt-muted hover:text-tt-text"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {plan && n === 0 && (
        <div className="rounded-lg border border-tt-border p-4 text-sm text-tt-muted">
          Nothing to buy in this scope.
          {plan.counts.already_in_ledger > 0 && ` ${plan.counts.already_in_ledger} already bought.`}
        </div>
      )}

      {/* ── Progress / result ──────────────────────────────────────────────────────── */}
      {progress && (
        <div className={`rounded-lg border p-4 ${progress.done ? 'border-tt-green/40 bg-tt-green/5' : 'border-tt-border'}`}>
          <div className="flex flex-wrap items-baseline justify-between gap-3">
            <h3 className="text-sm font-semibold text-tt-text">
              {progress.done ? 'Bought' : 'Buying'} {progress.bought} of {progress.total} — {money(progress.spent)}
            </h3>
            {progress.done && runId && (
              <PrintButton storeId={activeStore} runId={runId} onError={setErr} />
            )}
          </div>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-tt-card">
            <div
              className="h-full bg-tt-green transition-all"
              style={{ width: `${Math.round(100 * progress.bought / Math.max(1, progress.total))}%` }}
            />
          </div>
          {progress.failed > 0 && (
            <p className="mt-2 text-xs text-tt-red">
              {progress.failed} box(es) failed and were not charged.
            </p>
          )}
          {!progress.done && (
            <p className="mt-2 text-xs text-tt-muted">Leave this tab open. Nothing is lost if you don&rsquo;t.</p>
          )}
          {runId && !progress.done && !buying && (
            <ReleaseButton onRelease={release} />
          )}
        </div>
      )}

      {err && (
        <div className="rounded-md border border-tt-red/40 bg-tt-red/5 px-3 py-2 text-sm text-tt-red">
          {err}
        </div>
      )}

      {history && history.length > 0 && (
        <div className="rounded-lg border border-tt-border p-4">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="text-sm font-semibold text-tt-text">Print history</h3>
            <span className="text-xs text-tt-muted">
              {money(historyTotal)} on labels across all shops, all time
            </span>
          </div>
          <p className="mt-1 text-xs text-tt-muted">
            Labels stay printable — reprint a stack any time without buying again. Tick two or
            more to print them as one stack; singles are regrouped by SKU across shops, so the
            same item is one pile instead of one per shop.
          </p>

          {picked.size > 0 && (
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-md border border-tt-green/40 bg-tt-green/5 px-3 py-2">
              <span className="text-xs text-tt-text">
                {picked.size} run{picked.size === 1 ? '' : 's'} selected ·{' '}
                {history.filter((r) => picked.has(r.run_id)).reduce((t, r) => t + r.printable, 0)} labels
              </span>
              <span className="flex items-center gap-3">
                <PrintButton
                  runIds={[...picked]} onError={setErr} small section="singles"
                  label="Singles only" onPrinted={() => { void loadHistory(); }}
                />
                <PrintButton
                  runIds={[...picked]} onError={setErr} small section="mixed"
                  label="Bundles only" onPrinted={() => { void loadHistory(); }}
                />
                <PrintButton
                  runIds={[...picked]} onError={setErr} small
                  label="Everything" onPrinted={() => { void loadHistory(); }}
                />
                <button onClick={() => setPicked(new Set())} className="cursor-pointer text-xs text-tt-muted underline">
                  Clear
                </button>
              </span>
            </div>
          )}
          <ul className="mt-3 divide-y divide-tt-border">
            {history.map((r) => (
              <li key={r.run_id} className="flex flex-wrap items-center justify-between gap-3 py-2">
                {r.printable > 0 && (
                  <input
                    type="checkbox" className="mt-1 cursor-pointer" checked={picked.has(r.run_id)}
                    onChange={(e) => setPicked((prev) => {
                      const next = new Set(prev);
                      if (e.target.checked) next.add(r.run_id); else next.delete(r.run_id);
                      return next;
                    })}
                    aria-label={`Select ${r.scope ?? 'run'} for a combined print`}
                  />
                )}
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-tt-text">
                    {r.store_id && (
                      <span className="mr-2 rounded bg-tt-card px-1.5 py-0.5 text-[11px] text-tt-muted">
                        {storesData?.stores?.find((x) => x.id === r.store_id)?.name ?? 'shop'}
                      </span>
                    )}
                    {r.scope ?? 'Unnamed run'}
                    {r.claimed > 0 && (
                      <span className="ml-2 text-xs text-tt-yellow">
                        · {r.claimed} unfinished
                      </span>
                    )}
                    {r.failed > 0 && (
                      <span className="ml-2 text-xs text-tt-red">· {r.failed} failed</span>
                    )}
                    {/* The state an operator looks for the morning after. A bought run and a
                        printed run are otherwise identical, and a run that never got printed is
                        a day of parcels that never ship. */}
                    {r.printable > 0 && <PrintedBadge printed={r.printed} total={r.printable} />}
                  </span>
                  {(r.failures?.length ?? 0) > 0 && (
                    /* A count is not actionable. These orders were NOT charged and NOT labelled,
                       the box is buyable again, and someone has to deal with the reason — so the
                       reason and the order ids belong here, not in the database. */
                    <details className="mt-1">
                      <summary className="cursor-pointer text-xs text-tt-red">
                        What failed, and why
                      </summary>
                      <ul className="mt-1 space-y-1 text-[11px] text-tt-muted">
                        {(r.failures ?? []).map((f, i) => (
                          <li key={i}>
                            <span className="text-tt-red">{f.reason ?? `code ${f.code}`}</span>
                            {' — '}nothing charged, and this box is buyable again.
                            <span className="block font-mono">{f.orders.join(', ')}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
                  <span className="block text-xs text-tt-muted">
                    {r.at ? new Date(r.at).toLocaleString('en-US', {
                      month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
                      timeZone: 'America/Los_Angeles',
                    }) : 'unknown time'}
                    {' · '}{r.purchased} label{r.purchased === 1 ? '' : 's'}
                    {' · '}{money(r.spent)}
                    {r.singles > 0 && ` · ${r.singles} singles`}
                    {r.mixed > 0 && ` · ${r.mixed} mixed`}
                  </span>
                </span>
                <span className="flex shrink-0 gap-2">
                  {/* An unfinished manifest is money already approved but not yet spent, and its
                      labels do not exist until it is drained. Offering it here is the only way
                      back into a run whose tab was closed. */}
                  {r.claimed > 0 && !buying && (
                    <button
                      onClick={() => { void drain(r.run_id, r.labels, r.purchased, r.failed, r.spent); }}
                      className="cursor-pointer rounded-md border border-tt-yellow/50 px-3 py-1.5 text-xs text-tt-yellow hover:border-tt-yellow"
                    >
                      Finish {r.claimed} left
                    </button>
                  )}
                  {r.printable > 0 && (
                    <>
                      {/* Two piles, two files — they are worked by different people at the same
                          time, so splitting one PDF by hand at the banner is wasted effort. */}
                      {r.singles > 0 && (
                        <PrintButton
                          storeId={activeStore} runId={r.run_id} onError={setErr} small
                          section="singles" label={`Singles (${r.singles})`}
                          onPrinted={() => { void loadHistory(); }}
                        />
                      )}
                      {(r.mixed + r.unbound) > 0 && (
                        <PrintButton
                          storeId={activeStore} runId={r.run_id} onError={setErr} small
                          section="mixed" label={`Bundles (${r.mixed + r.unbound})`}
                          onPrinted={() => { void loadHistory(); }}
                        />
                      )}
                      <PrintButton
                        storeId={activeStore} runId={r.run_id} onError={setErr} small
                        onPrinted={() => { void loadHistory(); }}
                      />
                    </>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * A month grid of fulfilment days, multi-select.
 *
 * A calendar rather than a list because the question is "which nights am I behind on", and that
 * is a question about dates. Only days with unbought boxes are selectable — the rest are drawn
 * but inert, so the grid still reads as a calendar while making it impossible to pick a night
 * with nothing in it.
 *
 * Counts are shown per day because they are what decides the selection: 515 ready of 531 is a
 * night worth printing, 2 is not.
 */
function DayCalendar({ days, today, selected, onToggle }: {
  days: DayScope[]; today: string; selected: Set<string>; onToggle: (d: string) => void;
}) {
  const byDay = new Map(days.map((d) => [d.day, d]));
  if (!days.length) return <p className="mt-3 text-xs text-tt-muted">No unbought labels.</p>;

  // Span the offered range, so the grid has no holes where a quiet day fell.
  const sorted = [...days].map((d) => d.day).sort();
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  const cells: string[] = [];
  for (let t = Date.parse(`${first}T12:00:00Z`); t <= Date.parse(`${last}T12:00:00Z`); t += 86_400_000) {
    cells.push(new Date(t).toISOString().slice(0, 10));
  }
  // Pad to the week so columns line up under their weekday.
  const lead = new Date(`${cells[0]}T12:00:00Z`).getUTCDay();

  const total = [...selected].reduce((n, d) => n + (byDay.get(d)?.ready ?? 0), 0);

  return (
    <div className="mt-3">
      <div className="grid grid-cols-7 gap-1">
        {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((w, i) => (
          <div key={i} className="pb-1 text-center text-[11px] text-tt-muted/60">{w}</div>
        ))}
        {Array.from({ length: lead }, (_, i) => <div key={`pad${i}`} />)}
        {cells.map((d) => {
          const info = byDay.get(d);
          const on = selected.has(d);
          const usable = !!info && info.ready > 0;
          // THREE states, not two. `ready === 0` alone conflates two opposite situations:
          //   boxes === 0 — every label for that night is bought. Genuinely done.
          //   boxes  >  0 — nothing is bought and everything is under the age floor because the
          //                 show only just finished. WAITING, and buyable in a few hours.
          // Calling the second one done was actively misleading: lotsofsteals showed a tick on a
          // night holding 148 unbought boxes and 394 orders, which invites skipping it entirely.
          const done = !!info && info.ready === 0 && info.boxes === 0;
          const waiting = !!info && info.ready === 0 && info.boxes > 0;
          return (
            <button
              key={d}
              onClick={() => usable && onToggle(d)}
              disabled={!usable}
              aria-pressed={on}
              className={`rounded-md border px-1 py-1.5 text-center transition-colors ${
                on ? 'border-tt-green bg-tt-green/10 text-tt-text'
                  : usable ? 'cursor-pointer border-tt-border text-tt-text hover:border-tt-border-hover'
                    : waiting ? 'border-tt-yellow/30 text-tt-yellow/70'
                      : done ? 'border-transparent text-tt-muted/60'
                        : 'border-transparent text-tt-muted/30'
              }`}
              title={!info ? 'nothing to buy'
                : info.ready > 0 ? `${info.ready} ready of ${info.boxes} · ${info.orders} orders`
                  : waiting
                    ? `${info.boxes} boxes not ready yet`
                      + (info.heldLiveNow ? ` · ${info.heldLiveNow} orders from a show on air now` : '')
                      + (info.heldRecent ? ` · ${info.heldRecent} from shows that just ended — TikTok can still add to their boxes` : '')
                    : 'all labels bought for this night'}
            >
              <span className="block text-sm leading-tight">
                {Number(d.slice(8, 10))}
                {d === today && <span className="ml-0.5 text-[9px] text-tt-muted">•</span>}
              </span>
              <span className={`block text-[10px] leading-tight ${waiting ? 'text-tt-yellow/70' : 'text-tt-muted'}`}>
                {info?.ready ? info.ready : done ? '✓' : waiting ? 'wait' : ''}
              </span>
            </button>
          );
        })}
      </div>
      {(() => {
        // Spell out WHY a night is held, in the terms the work is actually thought about: a show
        // on air now versus one that has ended but whose combine window is still open. Measured
        // on a real evening, 409 held orders were the first and 115 the second — calling both
        // "too recent" made the second look like a mistake.
        const heldLive = days.reduce((n, d) => n + (d.heldLiveNow ?? 0), 0);
        const heldRecent = days.reduce((n, d) => n + (d.heldRecent ?? 0), 0);
        if (!heldLive && !heldRecent) return null;
        return (
          <p className="mt-2 rounded-md border border-tt-yellow/30 bg-tt-yellow/5 px-3 py-2 text-xs text-tt-muted">
            <span className="text-tt-yellow">Held back:</span>{' '}
            {heldLive > 0 && (
              <>
                <span className="text-tt-text">{heldLive.toLocaleString()}</span> order
                {heldLive === 1 ? '' : 's'} from a show that is on air right now
              </>
            )}
            {heldLive > 0 && heldRecent > 0 && ', and '}
            {heldRecent > 0 && (
              <>
                <span className="text-tt-text">{heldRecent.toLocaleString()}</span> from shows that
                have ended but are still inside TikTok&rsquo;s combine window — it can keep adding
                orders to those boxes for about a day, and a box bought early gets a label covering
                only part of the parcel
              </>
            )}
            . These become buyable on their own; nothing needs doing.
          </p>
        );
      })()}

      <p className="mt-2 text-xs text-tt-muted">
        {selected.size === 0 && 'Pick one or more nights.'}
        {selected.size === 1 && `1 night · ${total} labels ready`}
        {/*
          Deliberately "up to" for several nights. A combine group spanning midnight belongs to
          both nights and is counted under each, so adding the per-night numbers double-counts
          it — 64 of Sep 3's boxes straddle into Sep 4. The check resolves the real union in one
          click, so an approximate number here is honest and a precise-looking sum would not be.
        */}
        {selected.size > 1 && `${selected.size} nights · up to ${total} labels — some orders `
          + 'span midnight and belong to both, so the check will land a little lower'}
      </p>
      <p className="mt-1 text-[11px] text-tt-muted/60">
        A night runs 4am to 4am; a show ending after midnight stays with the night it started.
        The dot marks today.
      </p>
    </div>
  );
}

/**
 * Fetch the stack and open it in a tab, rather than linking straight at the route.
 *
 * A plain link hands the decision to the browser: even with `Content-Disposition: inline`,
 * Chrome's "download PDFs instead of opening them" setting saves the file, which is what
 * happened on the first real run. Fetching to a blob and opening THAT bypasses the header
 * entirely, so it renders in the viewer and Cmd-P works.
 *
 * It also makes failure legible. The route answers a 502 with JSON when it cannot fetch every
 * document, and a link would have opened a tab full of raw JSON; here that becomes an error
 * message. Nothing is lost either way — the labels are already bought and the stack can be
 * rebuilt at any time.
 */
function PrintButton({ storeId, runId, runIds, onError, small, label, onPrinted, section }: {
  storeId?: string; runId?: string; runIds?: string[];
  onError: (m: string) => void; small?: boolean; label?: string; onPrinted?: () => void;
  /** Omit for the whole stack; 'singles' and 'mixed' are the two piles as separate files. */
  section?: 'singles' | 'mixed';
}) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');

  /**
   * Fetch every part and stitch them into ONE file in the browser.
   *
   * The route can only return about 60 labels per response — a serverless reply is capped at
   * 4.5MB and a label page is roughly 55KB, so a 1,400-label stack would be a 96MB body that
   * cannot be sent at all. Merging client-side keeps each response small while still handing
   * over a single PDF, which is what actually gets printed.
   *
   * pdf-lib is imported dynamically so its ~350KB stays out of the dashboard bundle until
   * someone prints.
   */
  async function open() {
    setBusy(true); onError(''); setNote('');
    try {
      // No store_id when runs are combined: they may come from different shops, and the route
      // resolves each label's credentials from its own store.
      const many = (runIds?.length ?? 0) > 0;
      const ids = many ? (runIds as string[]).join(',') : (runId as string);
      const base = `/api/shipping/labels/pdf?run_id=${ids}`
        + (storeId && !many ? `&store_id=${encodeURIComponent(storeId)}` : '')
        + (section ? `&section=${section}` : '');

      const fetchPart = async (from?: number, to?: number) => {
        const u = from == null ? base : `${base}&from=${from}&to=${to}`;
        const res = await fetch(u);
        if (!res.ok) {
          let msg = `Could not build the stack (${res.status})`;
          try { const j = await res.json(); msg = j.error ?? msg; } catch { /* not JSON */ }
          throw new Error(msg);
        }
        return {
          bytes: new Uint8Array(await res.arrayBuffer()),
          parts: Number(res.headers.get('X-Parts') ?? '1') || 1,
          per: Number(res.headers.get('X-Labels-Per-Part') ?? '60') || 60,
          total: Number(res.headers.get('X-Total-Labels') ?? '0') || 0,
        };
      };

      setNote('Building…');
      const first = await fetchPart();
      let merged: Uint8Array<ArrayBufferLike> = first.bytes;

      if (first.parts > 1) {
        const { PDFDocument } = await import('pdf-lib');
        const out = await PDFDocument.create();
        const add = async (bytes: Uint8Array<ArrayBufferLike>) => {
          const src = await PDFDocument.load(bytes);
          for (const p of await out.copyPages(src, src.getPageIndices())) out.addPage(p);
        };
        // Part 1 is the un-sliced response, which for a multi-part stack is the whole thing —
        // so refetch it as an explicit slice rather than double-adding every label.
        for (let i = 0; i < first.parts; i++) {
          setNote(`Building… part ${i + 1} of ${first.parts}`);
          const from = i * first.per;
          const to = Math.min(from + first.per - 1, first.total - 1);
          const part = await fetchPart(from, to);
          await add(part.bytes);
        }
        merged = await out.save();
      }

      const blob = new Blob([merged as unknown as BlobPart], { type: 'application/pdf' });
      const objUrl = URL.createObjectURL(blob);
      const w = window.open(objUrl, '_blank');
      if (!w) {
        onError('Your browser blocked the new tab — allow pop-ups for this site, then print again.');
      }
      // Revoked late: revoking at once can race the new tab's load in some browsers.
      setTimeout(() => URL.revokeObjectURL(objUrl), 120_000);
      // The route marked these labels printed; reload so the badge reflects it immediately.
      onPrinted?.();
    } catch (e) {
      onError(`${e instanceof Error ? e.message : String(e)} — the labels are bought; try printing again.`);
    } finally { setBusy(false); setNote(''); }
  }

  return (
    <button
      onClick={open}
      disabled={busy}
      className={small
        ? 'cursor-pointer shrink-0 rounded-md border border-tt-border px-3 py-1.5 text-xs text-tt-text hover:border-tt-border-hover disabled:opacity-50'
        : 'cursor-pointer rounded-md bg-tt-green px-4 py-2 text-sm font-semibold text-black disabled:opacity-50'}
    >
      {busy ? (note || 'Building…') : label ?? (small ? 'Reprint' : 'Print labels')}
    </button>
  );
}


/** Two-step release, in-page for the same reason Buy is — a native dialog may never appear. */
function ReleaseButton({ onRelease }: { onRelease: () => void }) {
  const [sure, setSure] = useState(false);
  if (!sure) {
    return (
      <button onClick={() => setSure(true)} className="mt-3 cursor-pointer text-xs text-tt-muted underline">
        Release the unbought part of this run
      </button>
    );
  }
  return (
    <div className="mt-3 text-xs">
      <span className="text-tt-muted">Release the unbought boxes? Labels already bought are kept. </span>
      <button onClick={() => { setSure(false); onRelease(); }} className="cursor-pointer text-tt-red underline">
        Release
      </button>
      <span className="text-tt-muted"> · </span>
      <button onClick={() => setSure(false)} className="cursor-pointer text-tt-muted underline">
        Keep
      </button>
    </div>
  );
}

/** printed / partly / not printed, from the per-label marks. */
function PrintedBadge({ printed, total }: { printed: number; total: number }) {
  if (printed === 0) {
    return (
      <span className="ml-2 rounded bg-tt-yellow/10 px-1.5 py-0.5 text-[11px] text-tt-yellow">
        not printed
      </span>
    );
  }
  if (printed < total) {
    // A part-served stack is the interesting case: the download stopped halfway and some labels
    // genuinely never reached paper. Saying "printed" here would hide missing parcels.
    return (
      <span className="ml-2 rounded bg-tt-yellow/10 px-1.5 py-0.5 text-[11px] text-tt-yellow">
        {printed} of {total} printed
      </span>
    );
  }
  return (
    <span className="ml-2 rounded bg-tt-green/10 px-1.5 py-0.5 text-[11px] text-tt-green">
      printed
    </span>
  );
}

function Stat({ label, value, big }: { label: string; value: number; big?: boolean }) {
  return (
    <div>
      <div className={`${big ? 'text-2xl' : 'text-lg'} font-semibold text-tt-text`}>
        {value.toLocaleString()}
      </div>
      <div className="text-xs text-tt-muted">{label}</div>
    </div>
  );
}

function Radio({ checked, onChange, label, hint }: {
  checked: boolean; onChange: () => void; label: string; hint: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input type="radio" name="unbound" checked={checked} onChange={onChange} className="mt-0.5 cursor-pointer" />
      <span>
        <span className="text-sm text-tt-text">{label}</span>
        <span className="block text-xs text-tt-muted">{hint}</span>
      </span>
    </label>
  );
}
