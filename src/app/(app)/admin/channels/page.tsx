'use client';

import { useMemo, useState } from 'react';
import {
  useChannelMap,
  useSaveChannelMapping,
  useDeleteChannelMapping,
  type UnmappedChannel,
} from '@/hooks/useChannelMap';

// Admin: channel → store mapping + unmapped-session flagging (Part D).
// The /admin/* layout already gates this to app_metadata.role === 'admin'.
export default function ChannelMapPage() {
  const { data, isLoading, isError } = useChannelMap();
  const save = useSaveChannelMapping();
  const del = useDeleteChannelMapping();

  const [newName, setNewName] = useState('');
  const [newStore, setNewStore] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const stores = data?.stores ?? [];

  async function doSave(channel_name: string, store_id: string) {
    setErr(null); setNote(null);
    if (!channel_name.trim() || !store_id) { setErr('Channel name and store are both required.'); return; }
    try {
      const r = await save.mutateAsync({ channel_name: channel_name.trim(), store_id });
      setNote(`Mapped “${r.mapping.channel_name}” → store · backfilled ${r.backfilled_count} session${r.backfilled_count === 1 ? '' : 's'}.`);
      setNewName(''); setNewStore('');
    } catch (e) { setErr((e as Error).message); }
  }

  if (isError) {
    return <div className="p-8 text-sm text-tt-muted">Admin access required, or failed to load. (This page needs an admin account.)</div>;
  }

  return (
    <div className="mx-auto max-w-4xl p-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-tt-text">Channel → Store mapping</h1>
        <p className="text-xs text-tt-muted mt-1 max-w-2xl">
          A live’s store is derived from its streaming channel via this table — not guessed.
          A channel with no mapping leaves its sessions <span className="text-tt-red font-medium">unmapped</span> and
          flagged below until you map it. Mapping a channel backfills all its unmapped sessions.
        </p>
      </div>

      {(err || note) && (
        <div className={`rounded-lg px-4 py-2 text-sm ${err ? 'bg-tt-red/10 text-tt-red' : 'bg-tt-green/10 text-tt-green'}`}>
          {err || note}
        </div>
      )}

      {/* Unmapped sessions — the flag. Grouped by channel; map once to backfill all. */}
      <section className="rounded-[14px] border border-tt-border bg-tt-card overflow-hidden">
        <div className="px-5 py-4 border-b border-tt-border flex items-center justify-between">
          <h2 className="text-base font-semibold text-tt-text">
            Unmapped sessions
            {data && data.unmapped_total > 0 && (
              <span className="ml-2 text-[11px] font-semibold px-2 py-0.5 rounded-md bg-tt-red/15 text-tt-red">
                {data.unmapped_total} session{data.unmapped_total === 1 ? '' : 's'}
              </span>
            )}
          </h2>
        </div>
        <div className="p-5 space-y-3">
          {isLoading ? (
            <p className="text-sm text-tt-muted">Loading…</p>
          ) : (data?.unmapped_by_channel.length ?? 0) === 0 ? (
            <p className="text-sm text-tt-green">✓ All sessions are attributed to a store.</p>
          ) : (
            data!.unmapped_by_channel.map((c) => (
              <UnmappedRow key={c.channel_handle ?? '__none'} c={c} stores={stores} onMap={doSave} saving={save.isPending} />
            ))
          )}
        </div>
      </section>

      {/* Existing mappings + add form */}
      <section className="rounded-[14px] border border-tt-border bg-tt-card overflow-hidden">
        <div className="px-5 py-4 border-b border-tt-border">
          <h2 className="text-base font-semibold text-tt-text">Mappings</h2>
        </div>
        <div className="p-5 space-y-4">
          <div className="flex flex-wrap items-end gap-2">
            <label className="flex-1 min-w-[12rem]">
              <span className="block text-[11px] text-tt-muted uppercase tracking-wide mb-1">Channel name (exact)</span>
              <input
                value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="e.g. onlybidss"
                className="w-full rounded-lg border border-tt-border bg-white/5 px-3 py-2 text-sm text-tt-text outline-none focus:ring-1 focus:ring-tt-cyan/50"
              />
            </label>
            <label className="min-w-[10rem]">
              <span className="block text-[11px] text-tt-muted uppercase tracking-wide mb-1">Store</span>
              <select
                value={newStore} onChange={(e) => setNewStore(e.target.value)}
                className="w-full rounded-lg border border-tt-border bg-white/5 px-3 py-2 text-sm text-tt-text outline-none focus:ring-1 focus:ring-tt-cyan/50 appearance-none"
              >
                <option value="" className="bg-tt-card">Select…</option>
                {stores.map((s) => <option key={s.id} value={s.id} className="bg-tt-card">{s.name}</option>)}
              </select>
            </label>
            <button
              onClick={() => doSave(newName, newStore)} disabled={save.isPending}
              className="rounded-lg bg-tt-cyan px-4 py-2 text-sm font-semibold text-black hover:opacity-90 disabled:opacity-40"
            >
              {save.isPending ? 'Saving…' : 'Add / update'}
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-tt-border">
                  <th className="text-left px-3 py-2 text-[11px] text-tt-muted uppercase tracking-wide">Channel</th>
                  <th className="text-left px-3 py-2 text-[11px] text-tt-muted uppercase tracking-wide">Store</th>
                  <th className="text-right px-3 py-2 text-[11px] text-tt-muted uppercase tracking-wide">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(data?.mappings ?? []).map((m) => (
                  <tr key={m.id} className="border-b border-[rgba(255,255,255,0.04)]">
                    <td className="px-3 py-2 text-[13px] text-tt-text tabular-nums">{m.channel_name}</td>
                    <td className="px-3 py-2 text-[13px] text-tt-text">{m.store_name ?? m.store_id}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => { if (confirm(`Remove mapping for “${m.channel_name}”? Already-attributed sessions keep their store.`)) del.mutate(m.id); }}
                        className="px-3 py-1 rounded-lg text-[11px] font-semibold bg-tt-red/15 text-tt-red hover:bg-tt-red/25"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
                {(data?.mappings.length ?? 0) === 0 && !isLoading && (
                  <tr><td colSpan={3} className="px-3 py-6 text-center text-sm text-tt-muted">No mappings yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  );
}

function UnmappedRow({
  c, stores, onMap, saving,
}: {
  c: UnmappedChannel;
  stores: { id: string; name: string }[];
  onMap: (channel: string, store: string) => void;
  saving: boolean;
}) {
  const [store, setStore] = useState('');
  const label = c.channel_handle ?? '(no channel captured yet)';
  const mappable = !!c.channel_handle;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-tt-red/30 bg-tt-red/[0.04] px-3 py-2">
      <div className="flex-1 min-w-[10rem]">
        <span className="text-[13px] font-semibold text-tt-text tabular-nums">{label}</span>
        <span className="ml-2 text-[11px] text-tt-muted">{c.session_count} session{c.session_count === 1 ? '' : 's'}</span>
      </div>
      {mappable ? (
        <>
          <select
            value={store} onChange={(e) => setStore(e.target.value)}
            className="rounded-lg border border-tt-border bg-white/5 px-2 py-1.5 text-xs text-tt-text outline-none appearance-none"
          >
            <option value="" className="bg-tt-card">Map to store…</option>
            {stores.map((s) => <option key={s.id} value={s.id} className="bg-tt-card">{s.name}</option>)}
          </select>
          <button
            onClick={() => onMap(c.channel_handle!, store)} disabled={!store || saving}
            className="rounded-lg bg-tt-cyan px-3 py-1.5 text-xs font-semibold text-black hover:opacity-90 disabled:opacity-40"
          >
            Map &amp; backfill
          </button>
        </>
      ) : (
        <span className="text-[11px] text-tt-muted">Needs a channel name — reload the extension on this live to capture it.</span>
      )}
    </div>
  );
}
