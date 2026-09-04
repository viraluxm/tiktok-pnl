'use client';

/**
 * LabelsPanel — buy shipping labels for a shop's backlog, then print them in pick order.
 *
 * THE SHAPE OF THIS SCREEN IS A SAFETY DECISION, not a style one. Buying a label is
 * irreversible: TikTok's Create Packages call IS the purchase, there is no quote and no cancel.
 * So this is deliberately NOT a "Print labels" button.
 *
 *   1. CHECK FIRST, ALWAYS. Nothing can be bought until a check has been read, because the
 *      purchase route requires the box count that check reported. Change anything — the store,
 *      the unbound answer — and the plan is discarded and must be re-checked.
 *   2. THE BATCH SIZE IS PICKED. It defaults to 10, not to everything. A button that bought the
 *      whole backlog in one click is exactly what the API's required `limit` exists to prevent,
 *      and a UI that filled that limit in automatically would hand the risk straight back.
 *   3. THE COST IS ON THE BUTTON. Not in a tooltip, not after the fact.
 *   4. UNBOUND ORDERS BLOCK BY DEFAULT. Waiting is pre-selected, because the team binds shortly
 *      after a show and waiting is nearly always right.
 */

import { useCallback, useMemo, useState } from 'react';
import { useStores } from '@/hooks/useStores';

// Quick picks, smallest first. 'All' is offered but never pre-selected — see the header note.
const SIZE_PRESETS = [5, 10, 25, 50, 100];
const DEFAULT_SIZE = 10;

type UnboundChoice = 'wait' | 'skip' | 'include';

interface SectionRow { slip: string; sku_number: number | null; boxes: number }
interface ExcludedRow { group_key: string; order_ids: string[]; reason: string }
interface SpendWindows {
  run_total: number;
  last_7d: { labels: number; spent: number };
  last_30d: { labels: number; spent: number };
}
interface DryRun {
  counts: {
    candidates_in_lensed: number;
    candidate_boxes: number;
    excluded_too_recent: number;
    min_order_age_hours: number;
    /** Orders this check actually verified against TikTok. */
    verified: number;
    /** Boxes beyond the verification cap — a ceiling on the CHECK, not on the backlog. */
    not_verified_over_cap: number;
    confirmed_label_ready: number;
    boxes: number;
    orders: number;
    batched_boxes: number;
    bundle_boxes: number;
    sku_batches: number;
    single_box_sections: number;
    multi_unit_boxes: number;
    unbound_boxes: number;
    already_in_ledger: number;
    would_buy: number;
    one_order_boxes: number;
    multi_order_boxes: number;
  };
  spend_estimate: { avg_unit_price: number; estimated_total: number; basis: string; samples: number };
  spend_recent: SpendWindows;
  max_boxes_per_run: number;
  confirm_boxes: number;
  suggested_limit: number;
  batches: SectionRow[];
  excluded: ExcludedRow[];
}
interface BoughtRow {
  group_key: string; package_id: string; price: number | null; ship_type: string;
  already_existed?: true;
}
interface PurchaseResult {
  authorized: boolean;
  code?: string;
  reason?: string;
  run_id?: string;
  purchased: number;
  spent: number;
  failed?: number;
  remaining?: number;
  stopped_early?: boolean;
  bought?: BoughtRow[];
  failed_detail?: Array<{ group_key: string; code: number | null; message: string }>;
  spend_recent?: SpendWindows;
}

const money = (n: number) => `$${n.toFixed(2)}`;

export default function LabelsPanel() {
  const { data: storesData } = useStores();
  const activeStore = storesData?.activeStore ?? 'all';
  const storeName = storesData?.stores?.find((s) => s.id === activeStore)?.name ?? 'this store';

  const [checking, setChecking] = useState(false);
  const [plan, setPlan] = useState<DryRun | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [unbound, setUnbound] = useState<UnboundChoice>('wait');
  const [size, setSize] = useState<number>(DEFAULT_SIZE);
  const [buying, setBuying] = useState(false);
  const [result, setResult] = useState<PurchaseResult | null>(null);

  // Any change that could alter what would be bought discards the reviewed plan. The purchase
  // route would refuse a stale confirm_boxes anyway; throwing it away here means the operator
  // is never looking at numbers that no longer apply.
  const invalidate = useCallback(() => { setPlan(null); setResult(null); }, []);

  const check = useCallback(async () => {
    if (activeStore === 'all') return;
    setChecking(true); setErr(null); setResult(null);
    try {
      const p = new URLSearchParams({ store_id: activeStore });
      if (unbound === 'include') p.set('unbound', 'include');
      const res = await fetch(`/api/shipping/labels/dry-run?${p.toString()}`);
      // Read the body as text first: a route that died before its JSON handler returns an HTML
      // error page, and blindly calling .json() there throws and buries the real reason.
      const raw = await res.text();
      let json: (DryRun & { error?: string }) | null = null;
      try { json = JSON.parse(raw) as DryRun & { error?: string }; } catch { /* not JSON */ }
      if (!res.ok || !json) {
        setPlan(null);
        setErr(json?.error ?? raw.slice(0, 300) ?? `Check failed (${res.status})`);
        return;
      }
      setPlan(json);
      // Clamp the picked size down to what is actually available, but never up: a smaller
      // batch is always safe and the operator's choice of a small number is deliberate.
      setSize((s) => Math.max(1, Math.min(s, Math.max(1, json.counts?.would_buy ?? 1))));
    } catch (e) {
      setPlan(null);
      setErr(e instanceof Error ? e.message : 'Check failed');
    } finally {
      setChecking(false);
    }
  }, [activeStore, unbound]);

  const wouldBuy = plan?.counts.would_buy ?? 0;
  const unboundCount = plan?.counts.unbound_boxes ?? 0;
  const unit = plan?.spend_estimate.avg_unit_price ?? 0;
  const blockedByUnbound = unboundCount > 0 && unbound === 'wait';
  const buyCount = Math.min(size, wouldBuy);
  const estimate = useMemo(() => buyCount * unit, [buyCount, unit]);
  const canBuy = !!plan && wouldBuy > 0 && buyCount > 0 && !blockedByUnbound && !buying;

  async function buy() {
    if (!plan || !canBuy) return;
    const msg = `Buy ${buyCount} shipping label${buyCount === 1 ? '' : 's'} for ${storeName}?\n\n`
      + `Estimated ${money(estimate)} (about ${money(unit)} each).\n`
      + 'This cannot be undone — TikTok charges at purchase and labels cannot be cancelled.'
      + (buyCount < wouldBuy ? `\n\n${wouldBuy - buyCount} box(es) will be left for a later run.` : '');
    if (!window.confirm(msg)) return;

    setBuying(true); setErr(null);
    try {
      const p = new URLSearchParams({
        store_id: activeStore,
        confirm_boxes: String(plan.confirm_boxes),
        limit: String(buyCount),
      });
      if (unboundCount > 0) p.set('unbound', unbound === 'include' ? 'include' : 'skip');
      const res = await fetch(`/api/shipping/labels/purchase?${p.toString()}`, { method: 'POST' });
      const raw = await res.text();
      let json: PurchaseResult;
      try { json = JSON.parse(raw) as PurchaseResult; }
      catch {
        // Unparseable means we cannot tell what happened — say so, and point at the ledger,
        // which is the only record that can answer it.
        setErr(`Purchase returned an unreadable response (${res.status}). Check the ledger before retrying.`);
        setPlan(null);
        return;
      }
      setResult(json);
      // The plan is spent either way: boxes were bought, or the refusal means it moved.
      setPlan(null);
      if (!res.ok && !json.reason) {
        setErr(String((json as unknown as { error?: string }).error ?? `Purchase failed (${res.status})`));
      }
    } catch {
      setErr('Purchase failed — check the ledger before retrying');
    } finally {
      setBuying(false);
    }
  }

  if (activeStore === 'all') {
    return (
      <div className="rounded-lg border border-tt-border p-6 text-sm text-tt-muted">
        Pick a specific shop above. Labels are bought per shop, so &ldquo;All stores&rdquo; has
        nothing to buy.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Step 1 ─────────────────────────────────────────────────────────────────── */}
      <div className="rounded-lg border border-tt-border p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-tt-text">1 · Check what&rsquo;s ready</h3>
            <p className="mt-1 text-xs text-tt-muted">
              Verifies every order against TikTok before planning. Buys nothing.
            </p>
          </div>
          <button
            onClick={check}
            disabled={checking}
            className="cursor-pointer rounded-md bg-tt-green px-4 py-2 text-sm font-medium text-black disabled:cursor-not-allowed disabled:opacity-50"
          >
            {checking ? 'Checking…' : plan ? 'Re-check' : `Check ${storeName}`}
          </button>
        </div>

        {plan && (
          <div className="mt-4 space-y-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Ready to buy" value={wouldBuy} big />
              <Stat label="Orders covered" value={plan.counts.orders} />
              <Stat
                label={`Held back (under ${plan.counts.min_order_age_hours}h)`}
                value={plan.counts.excluded_too_recent}
                hint="Their combine group may still be growing"
              />
              <Stat label="Already bought" value={plan.counts.already_in_ledger} />
            </div>

            {/* The verification cap is a CEILING ON THIS CHECK, not on the backlog. Without
                this line "263 ready" reads as "263 left", and the other 249 boxes are invisible
                — the silent-truncation shape this codebase has been bitten by before. */}
            {plan.counts.not_verified_over_cap > 0 && (
              <div className="rounded-md border border-tt-border px-3 py-2 text-xs text-tt-muted">
                <span className="text-tt-text">
                  {plan.counts.not_verified_over_cap.toLocaleString()} more box
                  {plan.counts.not_verified_over_cap === 1 ? '' : 'es'}
                </span>{' '}
                could not be checked in one pass — this check verifies up to{' '}
                {plan.counts.verified.toLocaleString()} orders against TikTok. Buy this batch,
                then check again to reach the rest.
              </div>
            )}

            {/* Recent spend, so this run is judged against real numbers. */}
            <div className="flex flex-wrap gap-x-6 gap-y-1 rounded-md bg-tt-card px-3 py-2 text-xs text-tt-muted">
              <span>
                Last 7 days: <span className="text-tt-text">
                  {money(plan.spend_recent.last_7d.spent)}
                </span> · {plan.spend_recent.last_7d.labels} labels
              </span>
              <span>
                Last 30 days: <span className="text-tt-text">
                  {money(plan.spend_recent.last_30d.spent)}
                </span> · {plan.spend_recent.last_30d.labels} labels
              </span>
              <span>
                Average label: <span className="text-tt-text">{money(unit)}</span>
                {plan.spend_estimate.basis === 'fallback' && ' (estimated — no history yet)'}
              </span>
            </div>

            {plan.batches.length > 0 && (
              <details className="rounded-md border border-tt-border">
                <summary className="cursor-pointer px-3 py-2 text-xs text-tt-muted">
                  {plan.counts.sku_batches} SKU section{plan.counts.sku_batches === 1 ? '' : 's'}
                  {' · '}{plan.counts.bundle_boxes} mixed
                  {plan.counts.single_box_sections > 0
                    && ` · ${plan.counts.single_box_sections} section${plan.counts.single_box_sections === 1 ? '' : 's'} of one`}
                </summary>
                <ul className="border-t border-tt-border px-3 py-2 text-xs">
                  {plan.batches.map((b) => (
                    <li key={b.slip} className="flex justify-between py-0.5">
                      <span className="text-tt-text">{b.slip}</span>
                      <span className="text-tt-muted">{b.boxes}</span>
                    </li>
                  ))}
                  {plan.counts.bundle_boxes > 0 && (
                    <li className="flex justify-between py-0.5">
                      <span className="text-tt-text">MIXED — READ EACH LABEL</span>
                      <span className="text-tt-muted">{plan.counts.bundle_boxes}</span>
                    </li>
                  )}
                </ul>
              </details>
            )}
          </div>
        )}
      </div>

      {/* ── Unbound orders: an explicit answer, defaulting to wait ──────────────────── */}
      {plan && unboundCount > 0 && (
        <div className="rounded-lg border border-tt-yellow/40 bg-tt-yellow/5 p-4">
          <h3 className="text-sm font-semibold text-tt-text">
            {unboundCount} box{unboundCount === 1 ? '' : 'es'} in this batch have no SKU on file
          </h3>
          <p className="mt-1 text-xs text-tt-muted">
            Usually this just means the show ended recently and binding hasn&rsquo;t caught up.
          </p>
          <div className="mt-3 space-y-2">
            <Radio
              name="unbound" checked={unbound === 'wait'}
              onChange={() => { setUnbound('wait'); }}
              label="Wait — bind them, then re-check"
              hint="Recommended. Nothing is bought while this is selected."
            />
            <Radio
              name="unbound" checked={unbound === 'skip'}
              onChange={() => { setUnbound('skip'); }}
              label="Continue without them"
              hint="Buys the rest. These orders wait for a later run."
            />
            <Radio
              name="unbound" checked={unbound === 'include'}
              onChange={() => { setUnbound('include'); invalidate(); }}
              label="Buy them too"
              hint="Their labels say nothing about contents — the picker must look each order up by hand. Re-check required."
            />
          </div>
        </div>
      )}

      {/* ── Step 2 + 3 ─────────────────────────────────────────────────────────────── */}
      {plan && wouldBuy > 0 && (
        <div className="rounded-lg border border-tt-border p-4">
          <h3 className="text-sm font-semibold text-tt-text">2 · Choose how many to buy</h3>
          <p className="mt-1 text-xs text-tt-muted">
            Smaller is always safe — the rest stays for the next run. Cap is{' '}
            {plan.max_boxes_per_run} per run.
          </p>

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {SIZE_PRESETS.filter((n) => n <= wouldBuy).map((n) => (
              <button
                key={n}
                onClick={() => setSize(n)}
                className={`cursor-pointer rounded-md border px-3 py-1.5 text-sm ${
                  size === n
                    ? 'border-tt-green text-tt-text'
                    : 'border-tt-border text-tt-muted hover:text-tt-text'
                }`}
              >
                {n}
              </button>
            ))}
            <button
              onClick={() => setSize(Math.min(wouldBuy, plan.max_boxes_per_run))}
              className={`cursor-pointer rounded-md border px-3 py-1.5 text-sm ${
                size === Math.min(wouldBuy, plan.max_boxes_per_run)
                  ? 'border-tt-green text-tt-text'
                  : 'border-tt-border text-tt-muted hover:text-tt-text'
              }`}
            >
              All {Math.min(wouldBuy, plan.max_boxes_per_run)}
            </button>
            <input
              type="number" min={1} max={Math.min(wouldBuy, plan.max_boxes_per_run)}
              value={size}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (Number.isFinite(n)) {
                  setSize(Math.max(1, Math.min(n, Math.min(wouldBuy, plan.max_boxes_per_run))));
                }
              }}
              className="w-20 rounded-md border border-tt-input-border bg-tt-input-bg px-2 py-1.5 text-sm text-tt-text"
              aria-label="Number of labels to buy"
            />
          </div>

          <div className="mt-4 border-t border-tt-border pt-4">
            <h3 className="text-sm font-semibold text-tt-text">3 · Buy</h3>
            {blockedByUnbound ? (
              <p className="mt-2 text-xs text-tt-yellow">
                Answer the unbound question above first.
              </p>
            ) : (
              <p className="mt-1 text-xs text-tt-muted">
                Charged at purchase. Labels cannot be cancelled.
              </p>
            )}
            <button
              onClick={buy}
              disabled={!canBuy}
              className="mt-3 cursor-pointer rounded-md bg-tt-green px-4 py-2 text-sm font-semibold text-black disabled:cursor-not-allowed disabled:opacity-40"
            >
              {buying
                ? 'Buying…'
                : `Buy ${buyCount} label${buyCount === 1 ? '' : 's'} — about ${money(estimate)}`}
            </button>
          </div>
        </div>
      )}

      {plan && wouldBuy === 0 && (
        <div className="rounded-lg border border-tt-border p-4 text-sm text-tt-muted">
          Nothing to buy right now.
          {plan.counts.excluded_too_recent > 0 && (
            <> {plan.counts.excluded_too_recent} box(es) are still under the{' '}
            {plan.counts.min_order_age_hours}h age floor — check again later.</>
          )}
          {plan.counts.already_in_ledger > 0 && (
            <> {plan.counts.already_in_ledger} already have labels.</>
          )}
        </div>
      )}

      {/* ── Result ─────────────────────────────────────────────────────────────────── */}
      {result && <PurchaseSummary result={result} storeId={activeStore} onDone={invalidate} />}

      {err && (
        <div className="rounded-md border border-tt-red/40 bg-tt-red/5 px-3 py-2 text-sm text-tt-red">
          {err}
        </div>
      )}
    </div>
  );
}

function PurchaseSummary({
  result, storeId, onDone,
}: { result: PurchaseResult; storeId: string; onDone: () => void }) {
  if (!result.authorized) {
    return (
      <div className="rounded-lg border border-tt-yellow/40 bg-tt-yellow/5 p-4">
        <h3 className="text-sm font-semibold text-tt-text">Nothing bought</h3>
        <p className="mt-1 text-xs text-tt-muted">{result.reason ?? 'Refused.'}</p>
        <button onClick={onDone} className="mt-3 cursor-pointer text-xs text-tt-muted underline">
          Start over
        </button>
      </div>
    );
  }
  const bought = result.bought ?? [];
  return (
    <div className="rounded-lg border border-tt-green/40 bg-tt-green/5 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h3 className="text-sm font-semibold text-tt-text">
          Bought {result.purchased} label{result.purchased === 1 ? '' : 's'} — {money(result.spent)}
        </h3>
        {result.run_id && (
          <a
            href={`/api/shipping/labels/pdf?store_id=${encodeURIComponent(storeId)}&run_id=${result.run_id}`}
            target="_blank" rel="noreferrer"
            className="cursor-pointer rounded-md bg-tt-green px-4 py-2 text-sm font-semibold text-black"
          >
            Print labels
          </a>
        )}
      </div>

      {result.spend_recent && (
        <p className="mt-2 text-xs text-tt-muted">
          Last 7 days {money(result.spend_recent.last_7d.spent)} ·{' '}
          Last 30 days {money(result.spend_recent.last_30d.spent)}
        </p>
      )}

      {(result.remaining ?? 0) > 0 && (
        <p className="mt-2 text-xs text-tt-muted">
          {result.remaining} box(es) left. Re-check to buy the next batch.
          {result.stopped_early && ' (This run hit its time budget.)'}
        </p>
      )}

      {bought.length > 0 && (
        <details className="mt-3 rounded-md border border-tt-border">
          <summary className="cursor-pointer px-3 py-2 text-xs text-tt-muted">
            What each label cost
          </summary>
          <ul className="border-t border-tt-border px-3 py-2 text-xs">
            {bought.map((b) => (
              <li key={b.group_key} className="flex justify-between py-0.5">
                <span className="text-tt-muted">
                  {b.ship_type === '3' ? 'combined' : 'single'} · {b.group_key}
                </span>
                <span className="text-tt-text">
                  {b.already_existed ? 'already had a label' : b.price == null ? '—' : money(b.price)}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}

      {(result.failed ?? 0) > 0 && (
        <div className="mt-3 rounded-md border border-tt-red/40 px-3 py-2 text-xs text-tt-red">
          {result.failed} box(es) failed and were not charged.
          <ul className="mt-1 space-y-0.5">
            {(result.failed_detail ?? []).slice(0, 5).map((f) => (
              <li key={f.group_key}>{f.group_key}: {f.message}</li>
            ))}
          </ul>
        </div>
      )}

      <button onClick={onDone} className="mt-3 cursor-pointer text-xs text-tt-muted underline">
        Done
      </button>
    </div>
  );
}

function Stat({ label, value, hint, big }: {
  label: string; value: number; hint?: string; big?: boolean;
}) {
  return (
    <div>
      <div className={`${big ? 'text-2xl' : 'text-lg'} font-semibold text-tt-text`}>
        {value.toLocaleString()}
      </div>
      <div className="text-xs text-tt-muted">{label}</div>
      {hint && <div className="mt-0.5 text-[11px] text-tt-muted/70">{hint}</div>}
    </div>
  );
}

function Radio({ name, checked, onChange, label, hint }: {
  name: string; checked: boolean; onChange: () => void; label: string; hint: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-2">
      <input
        type="radio" name={name} checked={checked} onChange={onChange}
        className="mt-0.5 cursor-pointer"
      />
      <span>
        <span className="text-sm text-tt-text">{label}</span>
        <span className="block text-xs text-tt-muted">{hint}</span>
      </span>
    </label>
  );
}
