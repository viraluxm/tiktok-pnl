'use client';

/**
 * ShippingTab — the packing-station tab: pack-ready box counts, pick-ticket printing, and tracking
 * recovery, plus the "Start scanning" launcher for the full-screen pick/pack overlay.
 *
 * The full-screen scanner experience lives in PackStationOverlay (shared verbatim with the station
 * login at /fulfillment). ShippingTab owns the idle tab view, the fullscreen enter/exit (a browser
 * gesture requirement), and the pickedToday / picker selection that persist across enter/exit; it
 * renders PackStationOverlay with the existing /api/shipping/* endpoints and the active store.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useStores } from '@/hooks/useStores';
import { useEmployees } from '@/hooks/useEmployees';
import { printOrderTickets, type PickTicketGroup } from '@/lib/shipping/pickTickets';
import PackStationOverlay from '@/components/shipping/PackStationOverlay';

export default function ShippingTab() {
  const [focus, setFocus] = useState(false);
  const [pickedToday, setPickedToday] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  // Picker gate: who is packing. Held here (not in the overlay) so the selection persists across
  // enter/exit of the overlay, matching prior behavior.
  const [pickerId, setPickerId] = useState('');
  const { data: storesData } = useStores();
  const activeStore = storesData?.activeStore ?? 'all';
  // Eligible pickers: role 'fulfillment' AND status active/probation (no hosts, no former).
  const { employees } = useEmployees();
  const pickers = useMemo(
    () => employees
      .filter((e) => e.role?.trim().toLowerCase() === 'fulfillment' && (e.status === 'active' || e.status === 'probation'))
      .map((e) => ({ id: e.id, name: e.name })),
    [employees],
  );
  // Tracking coverage for the active store (label-barcode scanning depends on stored tracking).
  const [coverage, setCoverage] = useState<null | { total: number; with_tracking: number; missing_tracking: number }>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  // Resume cursor (order_id keyset) that survives across button clicks.
  const syncCursorRef = useRef<string | null>(null);
  // Pick-ticket batch: age window + the route's included/excluded counts.
  const [ticketDays, setTicketDays] = useState<'1' | '3' | '7' | 'all'>('3');
  const [ticketLoading, setTicketLoading] = useState(false);
  const [ticketInfo, setTicketInfo] = useState<null | {
    groups: PickTicketGroup[];
    days: string | number;
    included_boxes: number;
    included_orders: number;
    excluded_boxes: number;
    excluded_orders: number;
    no_timestamp_orders: number;
  }>(null);

  // Leaving the tab (unmount) while still full-screen → drop out of fullscreen.
  useEffect(() => () => {
    const d = document as Document & { webkitExitFullscreen?: () => Promise<void> | void; webkitFullscreenElement?: Element | null };
    if (d.fullscreenElement || d.webkitFullscreenElement) { try { (d.exitFullscreen ?? d.webkitExitFullscreen)?.call(d); } catch { /* ignore */ } }
  }, []);

  const storeName = activeStore === 'all'
    ? 'All stores'
    : (storesData?.stores?.find((s) => s.id === activeStore)?.name ?? 'this store');
  const scopeLabel = ticketInfo
    ? (ticketInfo.days === 'all' ? 'all dates' : `last ${ticketInfo.days} days`)
    : (ticketDays === 'all' ? 'all dates' : `last ${ticketDays} days`);

  // Load the pack-ready batch + its included/excluded counts (READ-ONLY, our DB only).
  const loadTickets = useCallback(async () => {
    setTicketLoading(true); setErr(null);
    try {
      const params = new URLSearchParams();
      if (activeStore && activeStore !== 'all') params.set('store_id', activeStore);
      params.set('days', ticketDays);
      const res = await fetch(`/api/shipping/pick-tickets?${params.toString()}`);
      if (!res.ok) { setTicketInfo(null); setErr('Failed to load pick tickets'); return; }
      const json = await res.json();
      setTicketInfo({
        groups: (json.groups ?? []) as PickTicketGroup[],
        days: json.days ?? ticketDays,
        included_boxes: json.included_boxes ?? 0,
        included_orders: json.included_orders ?? 0,
        excluded_boxes: json.excluded_boxes ?? 0,
        excluded_orders: json.excluded_orders ?? 0,
        no_timestamp_orders: json.no_timestamp_orders ?? 0,
      });
    } catch {
      setTicketInfo(null); setErr('Failed to load pick tickets');
    } finally {
      setTicketLoading(false);
    }
  }, [activeStore, ticketDays]);

  useEffect(() => { if (!focus) loadTickets(); }, [focus, loadTickets]);

  // Confirm with the REAL route numbers before opening the print window.
  function printTickets() {
    if (!ticketInfo) return;
    const { groups, included_boxes, included_orders, excluded_boxes, no_timestamp_orders } = ticketInfo;
    if (!groups.length) { setErr('No pack-ready orders in this window to print'); return; }
    let msg = `Print ${included_boxes} ticket${included_boxes === 1 ? '' : 's'} `
      + `(${included_orders} order${included_orders === 1 ? '' : 's'}) for ${storeName} — ${scopeLabel}?`;
    if (excluded_boxes > 0) {
      msg += `\n\n${excluded_boxes.toLocaleString()} older box${excluded_boxes === 1 ? '' : 'es'} excluded.`;
    }
    if (no_timestamp_orders > 0 && ticketInfo.days !== 'all') {
      msg += `\n${no_timestamp_orders} order${no_timestamp_orders === 1 ? '' : 's'} with no date not included.`;
    }
    if (included_boxes > 200) {
      msg += `\n\n⚠ Large batch: ${included_boxes.toLocaleString()} tickets will print.`;
    }
    if (!window.confirm(msg)) return;
    printOrderTickets(groups);
  }

  // ── tracking coverage (staleness) — visible without clicking; refreshed after a sync ──
  const loadCoverage = useCallback(async () => {
    if (!activeStore || activeStore === 'all') { setCoverage(null); return; }
    try {
      const res = await fetch(`/api/shipping/sync-tracking?store_id=${encodeURIComponent(activeStore)}`);
      setCoverage(res.ok ? await res.json() : null);
    } catch { setCoverage(null); }
  }, [activeStore]);
  useEffect(() => { if (!focus) loadCoverage(); }, [focus, loadCoverage]);

  // Recover tracking for the active store: loop the bounded route until done, showing progress.
  async function syncTracking() {
    if (!activeStore || activeStore === 'all') { setSyncMsg('Pick a specific store first.'); return; }
    setSyncing(true); setErr(null);
    let after: string | null = syncCursorRef.current;
    setSyncMsg(after ? 'Resuming label tracking…' : 'Fetching label tracking…');
    try {
      let filled = 0; let corrected = 0; let noLabel = 0; let guard = 0; let pass = 0;
      const soFar = () => `Filled ${filled} · corrected ${corrected}`;
      for (;;) {
        pass++;
        let res: Response;
        try {
          res = await fetch('/api/shipping/sync-tracking', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ store_id: activeStore, dry_run: false, after }),
          });
        } catch {
          syncCursorRef.current = after;
          setSyncMsg(filled + corrected > 0
            ? `${soFar()} so far, then lost connection. Click Fetch to resume.`
            : 'Couldn’t reach the server — check your connection and try again.');
          await loadCoverage(); return;
        }
        if (!res.ok) {
          syncCursorRef.current = after;
          const body = await res.json().catch(() => ({} as { error?: string }));
          const lead = filled + corrected > 0 ? `${soFar()} so far, then ` : '';
          if (res.status === 500) setSyncMsg(`${lead}failed: ${body.error ?? 'server error'}.${lead ? ' Click Fetch to resume.' : ''}`);
          else setSyncMsg(`${lead}failed (${res.status}).${lead ? ' Click Fetch to resume.' : ' Try again.'}`);
          await loadCoverage(); return;
        }
        const j: { filled?: number; corrected?: number; no_label?: number; examined?: number; remaining?: number;
                   done?: boolean; partial?: boolean; stopped_reason?: string | null; next_after?: string | null } = await res.json();
        filled += j.filled ?? 0; corrected += j.corrected ?? 0; noLabel = j.no_label ?? noLabel;
        const remaining = j.remaining ?? 0;
        if (j.partial) {
          syncCursorRef.current = j.next_after ?? after;
          const kind = /frequent|429|rate|too many/i.test(j.stopped_reason ?? '') ? 'rate limit' : 'error';
          setSyncMsg(`${soFar()} — paused (${kind}), ${remaining} left. Click Fetch to resume.`);
          await loadCoverage(); return;
        }
        const estTotal = pass + Math.ceil(remaining / Math.max(1, j.examined ?? 1));
        setSyncMsg(`Pass ${pass} of ~${estTotal} · ${soFar()}${remaining ? ` · ${remaining} to check…` : ''}`);
        if (j.done) { syncCursorRef.current = null; break; }
        if (!j.next_after || ++guard > 50) { syncCursorRef.current = j.next_after ?? after; break; }
        after = j.next_after;
      }
      await loadCoverage();
      const doneClean = syncCursorRef.current === null;
      setSyncMsg(`${soFar()}${noLabel ? ` · ${noLabel} have no label yet` : ''}.${doneClean ? ' Done.' : ' Click Fetch to continue.'}`);
    } catch {
      setSyncMsg('Sync failed — try again.');
    } finally {
      setSyncing(false);
    }
  }

  // ── true-fullscreen takeover (hides browser chrome). MUST be invoked from the tap handler. ──
  const enterFullscreen = () => {
    const el = document.documentElement as HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
    const req = el.requestFullscreen ?? el.webkitRequestFullscreen;
    try { const p = req?.call(el); if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => {}); } catch { /* denied — continue windowed */ }
  };
  const exitFullscreen = () => {
    const d = document as Document & { webkitExitFullscreen?: () => Promise<void> | void; webkitFullscreenElement?: Element | null };
    if (!(d.fullscreenElement || d.webkitFullscreenElement)) return;
    const ex = d.exitFullscreen ?? d.webkitExitFullscreen;
    try { const p = ex?.call(d); if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => {}); } catch { /* ignore */ }
  };

  // "Start scanning" — enter fullscreen from the gesture, then mount the overlay (which opens the
  // picker gate on mount, exactly as before).
  const beginSession = () => { setErr(null); enterFullscreen(); setFocus(true); };

  // ── idle (tab) view ──
  if (!focus) {
    return (
      <div>
        <div className="text-xl font-bold">Packing station</div>
        <div className="text-sm text-tt-muted mt-1 mb-6">Print your order-id pick tickets, then scan them to pick each box. Full-screen, scanner-driven.</div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={beginSession}
            className="w-full sm:w-auto min-h-[56px] px-8 py-5 rounded-2xl bg-tt-green text-black text-xl font-extrabold cursor-pointer hover:opacity-90 transition-opacity shadow-lg"
          >
            ▶ Start scanning
          </button>
          <button
            onClick={syncTracking}
            disabled={syncing || activeStore === 'all'}
            title="Recover tracking numbers from TikTok so label scanning works — run after buying labels"
            className="flex-1 sm:flex-none min-h-[44px] px-6 py-4 rounded-2xl border border-tt-border text-tt-text text-base font-semibold cursor-pointer hover:bg-tt-card-hover transition-colors disabled:opacity-50"
          >
            {syncing ? 'Fetching…' : '🔄 Fetch label tracking'}
          </button>
          <button
            onClick={printTickets}
            disabled={ticketLoading || !ticketInfo || ticketInfo.included_boxes === 0}
            className="flex-1 sm:flex-none min-h-[44px] px-6 py-4 rounded-2xl border border-tt-border text-tt-text text-base font-semibold cursor-pointer hover:bg-tt-card-hover transition-colors disabled:opacity-50"
          >
            {ticketLoading ? 'Loading…' : '🖨 Print pick tickets'}
          </button>
          <label className="flex items-center gap-2 text-sm text-tt-muted w-full sm:w-auto">
            <span>Age</span>
            <select
              value={ticketDays}
              onChange={(e) => setTicketDays(e.target.value as '1' | '3' | '7' | 'all')}
              className="flex-1 sm:flex-none min-h-[44px] px-3 py-2 rounded-xl bg-tt-card border border-tt-border text-tt-text cursor-pointer"
            >
              <option value="1">Last 1 day</option>
              <option value="3">Last 3 days</option>
              <option value="7">Last 7 days</option>
              <option value="all">All dates</option>
            </select>
          </label>
        </div>
        {/* Tracking coverage — staleness visible without clicking; label scanning needs stored tracking. */}
        {activeStore !== 'all' && (
          <div className="mt-3 text-sm">
            {syncMsg ? (
              <span className={syncing ? 'text-tt-cyan' : 'text-tt-text'}>{syncMsg}</span>
            ) : coverage ? (
              coverage.missing_tracking > 0 ? (
                <span className="text-tt-red font-semibold">{coverage.missing_tracking.toLocaleString()} order{coverage.missing_tracking === 1 ? '' : 's'} missing tracking — fetch before packing</span>
              ) : (
                <span className="text-tt-muted">{coverage.with_tracking.toLocaleString()} of {coverage.total.toLocaleString()} orders have tracking</span>
              )
            ) : (
              <span className="text-tt-muted">Checking tracking coverage…</span>
            )}
          </div>
        )}
        {/* ALWAYS surface what's included AND what's hidden — never a bare included count. */}
        <div className="mt-3 text-sm text-tt-muted">
          {ticketLoading || !ticketInfo ? (
            'Counting pack-ready boxes…'
          ) : (
            <>
              <span className="text-tt-text font-semibold">
                {ticketInfo.included_boxes.toLocaleString()} box{ticketInfo.included_boxes === 1 ? '' : 'es'}
              </span>
              {' '}({scopeLabel})
              {' · '}
              {ticketInfo.excluded_boxes > 0
                ? `${ticketInfo.excluded_boxes.toLocaleString()} older box${ticketInfo.excluded_boxes === 1 ? '' : 'es'} hidden`
                : 'no older boxes hidden'}
              {ticketInfo.no_timestamp_orders > 0 && (
                <> {' · '}{ticketInfo.no_timestamp_orders.toLocaleString()} order{ticketInfo.no_timestamp_orders === 1 ? '' : 's'} with no date{ticketInfo.days === 'all' ? '' : ' — not included'}</>
              )}
            </>
          )}
        </div>
        {err && <div className="mt-4 text-sm text-tt-red">{err}</div>}
        {pickedToday > 0 && <div className="mt-6 text-sm text-tt-muted">{pickedToday} {pickedToday === 1 ? 'box' : 'boxes'} picked this session</div>}
      </div>
    );
  }

  return (
    <PackStationOverlay
      mode="pick"
      endpoints={{ boxes: '/api/shipping/pick-tickets', scan: '/api/shipping/pick-list', confirm: '/api/shipping/confirm' }}
      pickers={pickers}
      storeLabel={storeName}
      pickerId={pickerId}
      onPickerChange={setPickerId}
      pickedCount={pickedToday}
      onBoxPicked={() => setPickedToday((n) => n + 1)}
      onExit={() => { exitFullscreen(); setFocus(false); }}
    />
  );
}
