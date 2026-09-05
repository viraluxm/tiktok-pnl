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

interface DayScope { day: string; boxes: number; ready: number; orders: number }
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
    sku_batches: number; unbound_boxes: number; already_in_ledger: number; would_buy: number;
  };
  spend_estimate: { avg_unit_price: number; estimated_total: number; basis: string };
  spend_recent: SpendWindows;
  confirm_boxes: number;
  batches: Array<{ slip: string; boxes: number }>;
}
interface Progress { total: number; bought: number; failed: number; spent: number; done: boolean }

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
  const [day, setDay] = useState<string | null>(null);
  const [lives, setLives] = useState<Set<string>>(new Set());
  const [unbound, setUnbound] = useState<UnboundChoice>('wait');

  const [loadingScopes, setLoadingScopes] = useState(false);
  const [checking, setChecking] = useState(false);
  const [plan, setPlan] = useState<DryRun | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [buying, setBuying] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  /** Any change to what would be bought discards the reviewed plan — never buy an unread plan. */
  const invalidate = useCallback(() => { setPlan(null); setRunId(null); setProgress(null); }, []);

  const scopeParams = useCallback(() => {
    const p = new URLSearchParams({ store_id: activeStore });
    if (scopeKind === 'day' && day) p.set('day', day);
    if (scopeKind === 'lives' && lives.size) p.set('session_ids', [...lives].join(','));
    return p;
  }, [activeStore, scopeKind, day, lives]);

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
        setDay(first?.day ?? null);
      })
      .catch(() => { if (!cancelled) { setScopes(null); setErr('Could not load shows'); } })
      .finally(() => { if (!cancelled) setLoadingScopes(false); });
    return () => { cancelled = true; };
  }, [activeStore, invalidate]);

  const scopeChosen = scopeKind === 'day' ? !!day : lives.size > 0;

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
  async function buy() {
    if (!plan) return;
    const n = plan.counts.would_buy;
    const est = plan.spend_estimate.avg_unit_price * n;
    const ok = window.confirm(
      `Buy ${n} shipping label${n === 1 ? '' : 's'} for ${storeName}?\n\n`
      + `Scope: ${plan.scope}\n`
      + `Estimated ${money(est)} (about ${money(plan.spend_estimate.avg_unit_price)} each).\n\n`
      + 'This cannot be undone — TikTok charges at purchase and labels cannot be cancelled.',
    );
    if (!ok) return;

    setBuying(true); setErr(null);
    try {
      const ap = scopeParams();
      ap.set('confirm_boxes', String(plan.confirm_boxes));
      if (plan.counts.unbound_boxes > 0) ap.set('unbound', unbound === 'include' ? 'include' : 'skip');
      const aRes = await fetch(`/api/shipping/labels/authorize?${ap.toString()}`, { method: 'POST' });
      const aJson = await aRes.json();
      if (!aJson.authorized || !aJson.run_id) {
        setErr(aJson.reason ?? aJson.error ?? `Could not authorise (${aRes.status})`);
        return;
      }
      const id = aJson.run_id as string;
      setRunId(id);
      const total = (aJson.claimed as number) || n;
      setProgress({ total, bought: 0, failed: 0, spent: 0, done: false });

      // Drain. Each pass reports what remains, so progress reflects the ledger rather than a
      // guess, and a stalled pass surfaces instead of looping forever.
      let bought = 0, failed = 0, spent = 0, guard = 0;
      for (;;) {
        if (guard++ > Math.ceil(total / DRAIN_CHUNK) + 10) {
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
        // No forward progress and nothing failed means the manifest is stuck, not slow.
        if ((d.purchased ?? 0) === 0 && (d.failed ?? 0) === 0) {
          setErr('Nothing left to buy in this run'); break;
        }
      }
      setPlan(null);
    } catch (e) {
      setErr(`Purchase interrupted: ${e instanceof Error ? e.message : String(e)}. `
        + 'Nothing is lost — re-check to see what remains.');
    } finally { setBuying(false); }
  }

  async function release() {
    if (!runId) return;
    if (!window.confirm('Release the unbought part of this run? Labels already bought are kept.')) return;
    const p = new URLSearchParams({ store_id: activeStore, run_id: runId });
    const res = await fetch(`/api/shipping/labels/authorize?${p.toString()}`, { method: 'DELETE' });
    const j = await res.json();
    setErr(res.ok ? `Released ${j.released} unbought box(es).` : (j.error ?? 'Release failed'));
    invalidate();
  }

  if (activeStore === 'all') {
    return (
      <div className="rounded-lg border border-tt-border p-6 text-sm text-tt-muted">
        Pick a specific shop above. Labels are bought per shop, so &ldquo;All stores&rdquo; has
        nothing to buy.
      </div>
    );
  }

  const unboundCount = plan?.counts.unbound_boxes ?? 0;
  const blocked = unboundCount > 0 && unbound === 'wait';
  const n = plan?.counts.would_buy ?? 0;
  const unit = plan?.spend_estimate.avg_unit_price ?? 0;

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
              <div className="mt-3">
                <select
                  value={day ?? ''}
                  onChange={(e) => { setDay(e.target.value || null); invalidate(); }}
                  className="w-full rounded-md border border-tt-input-border bg-tt-input-bg px-3 py-2 text-sm text-tt-text"
                >
                  <option value="">Pick a day…</option>
                  {scopes.days.map((d) => (
                    <option key={d.day} value={d.day}>
                      {fmtDay(d.day)}{d.day === scopes.today ? ' (today)' : ''}
                      {' · '}{d.ready} ready{d.ready !== d.boxes ? ` of ${d.boxes}` : ''}
                      {' · '}{d.orders} orders
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[11px] text-tt-muted/70">
                  A day runs 4am to 4am, so a show ending after midnight stays with the night it
                  started.
                </p>
              </div>
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
          <button
            onClick={buy}
            disabled={blocked || buying}
            className="mt-3 cursor-pointer rounded-md bg-tt-green px-4 py-2 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40"
          >
            {buying ? 'Buying…' : `Buy ${n} label${n === 1 ? '' : 's'} — about ${money(n * unit)}`}
          </button>
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
              <a
                href={`/api/shipping/labels/pdf?store_id=${encodeURIComponent(activeStore)}&run_id=${runId}`}
                target="_blank" rel="noreferrer"
                className="cursor-pointer rounded-md bg-tt-green px-4 py-2 text-sm font-semibold text-black"
              >
                Print labels
              </a>
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
            <button onClick={release} className="mt-3 cursor-pointer text-xs text-tt-muted underline">
              Release the unbought part of this run
            </button>
          )}
        </div>
      )}

      {err && (
        <div className="rounded-md border border-tt-red/40 bg-tt-red/5 px-3 py-2 text-sm text-tt-red">
          {err}
        </div>
      )}
    </div>
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
