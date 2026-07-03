'use client';

/**
 * /pickpack — fulfillment entry point: select a live session's orders → Buy labels (stub).
 *
 * STUB mode creates the boxes/slips that /pick consumes. It does NOT buy a real TikTok
 * label or ship anything — the safe test path. Orders are pulled from the session's bound
 * auction items (live_auction_items.client_idempotency_key = order_id).
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { createClient } from '@/lib/supabase/client';
import { kpiAllowlisted } from '@/lib/fulfillment/kpiAccess';
import FulfillmentNav from '@/components/fulfillment/FulfillmentNav';

interface Session { id: string; title: string; status: string; started_at: string | null; tiktok_live_id: string | null }

export default function PickPackEntry() {
  const supabase = createClient();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [sessionId, setSessionId] = useState('');
  const [orders, setOrders] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<{ boxes_created: number; orders_selected: number; note: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [kpiOn, setKpiOn] = useState(false);

  useEffect(() => {
    supabase.from('live_sessions').select('id, title, status, started_at, tiktok_live_id')
      .order('started_at', { ascending: false })
      .then(({ data }) => setSessions((data as Session[]) ?? []));
    kpiAllowlisted(supabase).then(setKpiOn);
  }, [supabase]);

  const loadOrders = useCallback(async (sid: string) => {
    setResult(null); setErr(null);
    const { data } = await supabase
      .from('live_auction_items').select('client_idempotency_key')
      .eq('session_id', sid).not('client_idempotency_key', 'is', null);
    const ids = [...new Set((data ?? []).map((r) => String(r.client_idempotency_key)).filter(Boolean))];
    setOrders(ids);
    setSelected(new Set(ids)); // default: all selected
  }, [supabase]);

  function pickSession(sid: string) { setSessionId(sid); if (sid) loadOrders(sid); else { setOrders([]); setSelected(new Set()); } }

  function toggle(id: string) {
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }

  async function buyLabels() {
    if (!sessionId || selected.size === 0) return;
    setBusy(true); setErr(null); setResult(null);
    const res = await fetch('/api/fulfillment/buy-labels', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, orderIds: [...selected] }),
    });
    const json = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) { setErr(json.error || 'Failed'); return; }
    setResult(json);
  }

  return (
    <div className="min-h-screen bg-tt-bg text-tt-text p-6">
      <div className="max-w-3xl mx-auto">
        <FulfillmentNav kpiOn={kpiOn} />
        <h1 className="text-3xl font-bold mb-1">Fulfillment — buy labels</h1>
        <p className="text-sm text-tt-muted mb-2">Pick a live session, select orders, buy labels. <span className="text-tt-cyan">STUB mode: creates boxes for the pick queue — no real label purchased, nothing shipped.</span></p>
        <p className="text-xs text-tt-muted mb-6">Pick &amp; Pack run on provisioned devices — set them up under <Link href="/pickpack/settings" className="text-tt-cyan underline">Settings &amp; Barcodes → Devices</Link>.</p>

        <div className="rounded-2xl border border-tt-border bg-tt-card p-4 mb-5">
          <label className="block text-xs uppercase tracking-wide text-tt-muted mb-2">Live session</label>
          <select value={sessionId} onChange={(e) => pickSession(e.target.value)}
            className="w-full bg-tt-input-bg border border-tt-input-border rounded-lg px-3 py-2">
            <option value="">Select a session…</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>{s.title} · {s.status} · {s.started_at ? new Date(s.started_at).toLocaleDateString() : 'no date'}</option>
            ))}
          </select>
        </div>

        {err && <div className="mb-4 rounded-lg border border-tt-red/40 bg-tt-red/10 px-4 py-3 text-sm text-tt-red">{err}</div>}

        {sessionId && (
          <div className="rounded-2xl border border-tt-border bg-tt-card p-4 mb-5">
            <div className="flex items-center justify-between mb-3">
              <span className="font-semibold">{orders.length} order(s) in this session</span>
              <div className="flex gap-2 text-sm">
                <button onClick={() => setSelected(new Set(orders))} className="text-tt-cyan">Select all</button>
                <button onClick={() => setSelected(new Set())} className="text-tt-muted">Clear</button>
              </div>
            </div>
            <div className="max-h-80 overflow-y-auto space-y-1">
              {orders.map((id) => (
                <label key={id} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-tt-card-hover cursor-pointer">
                  <input type="checkbox" checked={selected.has(id)} onChange={() => toggle(id)} />
                  <span className="font-mono text-sm">{id}</span>
                </label>
              ))}
              {orders.length === 0 && <div className="text-tt-muted text-sm">No bound orders for this session.</div>}
            </div>
          </div>
        )}

        <button onClick={buyLabels} disabled={!sessionId || selected.size === 0 || busy}
          className="w-full py-4 rounded-2xl bg-tt-green text-black text-lg font-bold disabled:opacity-50">
          {busy ? 'Creating boxes…' : `Buy labels (stub) — ${selected.size} order(s)`}
        </button>

        {result && (
          <div className="mt-5 rounded-2xl border border-tt-green/50 bg-tt-green/10 p-5">
            <div className="text-lg font-semibold text-tt-green">✓ {result.boxes_created} box(es) created from {result.orders_selected} order(s)</div>
            <div className="text-sm text-tt-muted mt-1">{result.note}</div>
            <div className="mt-3 text-sm text-tt-muted">Boxes are ready — pickers will see them on the Pick device.</div>
          </div>
        )}
      </div>
    </div>
  );
}
