'use client';

/**
 * /fulfillment/provision — ingest the one-time provisioning code from an owner (chunk 6).
 * Decodes → setSession (device becomes the shared fulfillment account) → stores device in
 * localStorage → validate-device → /fulfillment. This exercises the chunk-6 session handoff.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';

export default function ProvisionPage() {
  const router = useRouter();
  const supabase = createClient();
  const [code, setCode] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true); setMsg(null);
    let payload: { device_id?: string; kind?: string; token?: string; session?: { access_token?: string; refresh_token?: string } };
    try { payload = JSON.parse(atob(code.trim())); } catch { setBusy(false); setMsg('Invalid provisioning code.'); return; }
    const { device_id, kind, token, session } = payload || {};
    if (!device_id || !kind || !token || !session?.access_token || !session?.refresh_token) { setBusy(false); setMsg('Code is missing required fields.'); return; }

    const { error: sErr } = await supabase.auth.setSession({ access_token: session.access_token, refresh_token: session.refresh_token });
    if (sErr) { setBusy(false); setMsg(`Session error: ${sErr.message}`); return; }

    localStorage.setItem('lensed.fulfillment.device', JSON.stringify({ device_id, kind, token }));
    const res = await fetch('/api/fulfillment/validate-device', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    const json = await res.json();
    setBusy(false);
    if (!json.valid) { setMsg(`Device not valid (${json.reason || 'unknown'}).`); return; }
    router.replace('/fulfillment');
  }

  return (
    <div className="min-h-screen bg-tt-bg text-tt-text flex items-center justify-center p-6">
      <div className="w-full max-w-md">
        <h1 className="text-2xl font-bold mb-2">Provision device</h1>
        <p className="text-sm text-tt-muted mb-4">Paste the one-time provisioning code from an owner (Pick/Pack Settings → Devices → Add device).</p>
        <textarea value={code} onChange={(e) => setCode(e.target.value)} placeholder="Provisioning code…"
          className="w-full h-28 bg-tt-input-bg border border-tt-input-border rounded-lg p-2 font-mono text-xs mb-3 break-all" />
        {msg && <div className="mb-3 rounded-lg border border-tt-red/40 bg-tt-red/10 px-3 py-2 text-sm text-tt-red">{msg}</div>}
        <button onClick={submit} disabled={busy || !code.trim()}
          className="w-full py-3 rounded-xl bg-tt-cyan text-black font-semibold disabled:opacity-50">
          {busy ? 'Setting up…' : 'Provision this device'}
        </button>
      </div>
    </div>
  );
}
