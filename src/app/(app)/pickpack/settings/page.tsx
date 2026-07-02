'use client';

/**
 * /pickpack/settings — one-time config for the pick/pack module (org-shared).
 *
 *  - Cubicles: generate a fixed set 1..N (barcode CUBICLE-n). Printable Code128 sheet,
 *    two per cubicle (barcodes go on both sides of each bin).
 *  - Sections: map a section barcode → an inventory SKU (strict one-SKU-per-section,
 *    enforced by the DB partial unique index; we surface the conflict). Printable sheet.
 *
 * Writes via the browser Supabase client under org RLS (is_org_member).
 */

import { useCallback, useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { code128ToSvg } from '@/lib/barcode/code128';

interface Cubicle { id: string; cubicle_number: number; cubicle_barcode: string; is_active: boolean }
interface Section { id: string; section_barcode: string; inventory_sku_id: string; label: string | null; is_active: boolean }
interface Sku { id: string; sku_number: number; title: string; barcode: string }
type WorkerRole = 'picker' | 'packer' | 'both';
interface Worker { id: string; name: string; role: WorkerRole; is_active: boolean }
interface Device { id: string; kind: 'picker' | 'packer'; label: string | null; is_active: boolean; last_seen_at: string | null }

export default function PickPackSettings() {
  const supabase = createClient();
  const [orgId, setOrgId] = useState<string | null>(null);
  const [cubicles, setCubicles] = useState<Cubicle[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [skus, setSkus] = useState<Sku[]>([]);
  const [count, setCount] = useState(30);
  const [skuForSection, setSkuForSection] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  // Workers roster (chunk 2)
  const [workers, setWorkers] = useState<Worker[]>([]);
  const [isOwner, setIsOwner] = useState(false);          // store-owner → can manage roster (RLS is the hard gate)
  const [newName, setNewName] = useState('');
  const [newRole, setNewRole] = useState<WorkerRole>('both');
  const [showInactive, setShowInactive] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editRole, setEditRole] = useState<WorkerRole>('both');
  // Devices (chunk 6)
  const [devices, setDevices] = useState<Device[]>([]);
  const [newDevKind, setNewDevKind] = useState<'picker' | 'packer'>('picker');
  const [newDevLabel, setNewDevLabel] = useState('');
  const [provCode, setProvCode] = useState<string | null>(null); // one-time provisioning payload (base64)

  const load = useCallback(async () => {
    const { data: mem } = await supabase.from('organization_members').select('org_id').limit(1).maybeSingle();
    const org = (mem?.org_id as string) ?? null;
    setOrgId(org);
    const [{ data: c }, { data: s }, { data: inv }, { data: w }, { data: d }, owner] = await Promise.all([
      supabase.from('cubicles').select('id, cubicle_number, cubicle_barcode, is_active').order('cubicle_number'),
      supabase.from('pick_sections').select('id, section_barcode, inventory_sku_id, label, is_active').order('section_barcode'),
      supabase.from('inventory_skus').select('id, sku_number, title, barcode').eq('is_active', true).order('sku_number'),
      supabase.from('fulfillment_workers').select('id, name, role, is_active').order('name'),
      supabase.from('fulfillment_devices').select('id, kind, label, is_active, last_seen_at').order('created_at'),
      supabase.rpc('is_store_owner_in_org', { p_org: org }),
    ]);
    setCubicles((c as Cubicle[]) ?? []);
    setSections((s as Section[]) ?? []);
    setSkus((inv as Sku[]) ?? []);
    setWorkers((w as Worker[]) ?? []);
    setDevices((d as Device[]) ?? []);
    setIsOwner(owner?.data === true);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  const sectionedSkuIds = new Set(sections.filter((s) => s.is_active).map((s) => s.inventory_sku_id));

  async function generateCubicles() {
    if (!orgId) return;
    const rows = Array.from({ length: Math.max(1, Math.min(200, count)) }, (_, i) => ({
      org_id: orgId, cubicle_number: i + 1, cubicle_barcode: `CUBICLE-${i + 1}`, is_active: true,
    }));
    const { error } = await supabase.from('cubicles').upsert(rows, { onConflict: 'org_id,cubicle_number' });
    setMsg(error ? `Cubicles: ${error.message}` : `Generated ${rows.length} cubicles.`);
    load();
  }

  async function addSection() {
    if (!orgId || !skuForSection) return;
    const sku = skus.find((s) => s.id === skuForSection);
    if (!sku) return;
    if (sectionedSkuIds.has(sku.id)) { setMsg(`SKU #${sku.sku_number} already has an active section (one-SKU-per-section).`); return; }
    // section_barcode = the SKU's OWN barcode (inventory_skus.barcode) so the one physical
    // SKU label does double duty: bind at the live AND section scan at /pick.
    const row = { org_id: orgId, section_barcode: sku.barcode, inventory_sku_id: sku.id, label: `#${sku.sku_number} ${sku.title}`.slice(0, 60), is_active: true };
    const { error } = await supabase.from('pick_sections').insert(row);
    // 23505 = the (org, section_barcode) unique OR the one-active-section-per-SKU partial index
    setMsg(error ? (error.code === '23505' ? `Conflict: that section barcode or SKU mapping already exists.` : error.message) : `Mapped ${row.section_barcode} → #${sku.sku_number}.`);
    setSkuForSection('');
    load();
  }

  // ===== Workers roster CRUD (browser client → 039 RLS is the hard gate) =====
  async function addWorker() {
    if (!orgId || !newName.trim()) return;
    const name = newName.trim();
    // Dup-name: schema allows duplicates (id disambiguates) — warn, don't block.
    const dup = workers.some((w) => w.is_active && w.name.trim().toLowerCase() === name.toLowerCase());
    if (dup && !window.confirm(`A worker named "${name}" already exists — add anyway?`)) return;
    const { error } = await supabase.from('fulfillment_workers').insert({ org_id: orgId, name, role: newRole });
    setMsg(error ? `Add worker: ${error.message}` : `Added ${name} (${newRole}).`);
    if (!error) { setNewName(''); setNewRole('both'); }
    load();
  }
  function startEdit(w: Worker) { setEditId(w.id); setEditName(w.name); setEditRole(w.role); }
  async function saveEdit() {
    if (!editId || !editName.trim()) return;
    const { error } = await supabase.from('fulfillment_workers').update({ name: editName.trim(), role: editRole }).eq('id', editId);
    setMsg(error ? `Edit: ${error.message}` : `Updated ${editName.trim()}.`);
    if (!error) setEditId(null);
    load();
  }
  async function setActive(w: Worker, active: boolean) {
    const { error } = await supabase.from('fulfillment_workers').update({ is_active: active }).eq('id', w.id);
    setMsg(error ? `${active ? 'Reactivate' : 'Deactivate'}: ${error.message}` : `${active ? 'Reactivated' : 'Deactivated'} ${w.name}.`);
    load();
  }
  const roleLabel: Record<WorkerRole, string> = { picker: 'Picker', packer: 'Packer', both: 'Both' };
  const activeWorkers = workers.filter((w) => w.is_active);
  const inactiveWorkers = workers.filter((w) => !w.is_active);

  // ===== Devices (chunk 6): provision (server-hands-session) + revoke =====
  async function addDevice() {
    const res = await fetch('/api/fulfillment/provision-device', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: newDevKind, label: newDevLabel.trim() }),
    });
    const json = await res.json();
    if (!res.ok) { setMsg(`Provision: ${json.error || 'failed'}${json.detail ? ' — ' + json.detail : ''}`); return; }
    // One-time payload the physical device ingests (chunk 7): device_id + kind + token + session.
    setProvCode(btoa(JSON.stringify({ device_id: json.device_id, kind: json.kind, token: json.token, session: json.session })));
    setMsg(`Device "${json.label || json.kind}" provisioned — copy the code below onto the device ONCE.`);
    setNewDevLabel(''); load();
  }
  async function setDeviceActive(dev: Device, active: boolean) {
    const { error } = await supabase.from('fulfillment_devices').update({ is_active: active }).eq('id', dev.id);
    setMsg(error ? `${active ? 'Reactivate' : 'Revoke'} device: ${error.message}` : `${active ? 'Reactivated' : 'Revoked'} ${dev.label || dev.kind}.`);
    load();
  }

  const skuById = new Map(skus.map((s) => [s.id, s]));

  return (
    <div className="min-h-screen bg-tt-bg text-tt-text p-6">
      <style>{`@media print { body * { visibility: hidden; } .print-sheet, .print-sheet * { visibility: visible; } .print-sheet { position: absolute; left: 0; top: 0; width: 100%; } .no-print { display: none !important; } }`}</style>
      <div className="max-w-4xl mx-auto">
        <h1 className="text-3xl font-bold mb-2">Pick/Pack settings</h1>
        <p className="text-sm text-tt-muted mb-6">Org-shared cubicles & shelf sections. Configure once, print the barcode sheets.</p>
        {msg && <div className="mb-5 rounded-lg border border-tt-border bg-tt-card-hover px-4 py-3 text-sm">{msg}</div>}

        {/* ===== Cubicles ===== */}
        <section className="mb-10 no-print">
          <h2 className="text-xl font-semibold mb-3">Cubicles ({cubicles.length})</h2>
          <div className="flex items-center gap-3 mb-4">
            <input type="number" value={count} onChange={(e) => setCount(Number(e.target.value))} min={1} max={200}
              className="w-28 bg-tt-input-bg border border-tt-input-border rounded-lg px-3 py-2" />
            <button onClick={generateCubicles} className="px-4 py-2 rounded-lg bg-tt-cyan text-black font-semibold">Generate 1…N</button>
            <button onClick={() => window.print()} className="px-4 py-2 rounded-lg border border-tt-border text-tt-muted">Print barcode sheets</button>
          </div>
          <div className="flex flex-wrap gap-2">
            {cubicles.map((c) => <span key={c.id} className="px-3 py-1 rounded-lg border border-tt-border bg-tt-card font-mono text-sm">#{c.cubicle_number}</span>)}
          </div>
        </section>

        {/* ===== Sections ===== */}
        <section className="mb-10 no-print">
          <h2 className="text-xl font-semibold mb-3">Sections ({sections.length})</h2>
          <div className="flex items-center gap-3 mb-4">
            <select value={skuForSection} onChange={(e) => setSkuForSection(e.target.value)}
              className="bg-tt-input-bg border border-tt-input-border rounded-lg px-3 py-2 min-w-[18rem]">
              <option value="">Select a SKU to map…</option>
              {skus.map((s) => <option key={s.id} value={s.id} disabled={sectionedSkuIds.has(s.id)}>#{s.sku_number} {s.title}{sectionedSkuIds.has(s.id) ? ' (mapped)' : ''}</option>)}
            </select>
            <button onClick={addSection} disabled={!skuForSection} className="px-4 py-2 rounded-lg bg-tt-cyan text-black font-semibold disabled:opacity-50">Add section</button>
          </div>
          <div className="space-y-2">
            {sections.map((s) => {
              const sku = skuById.get(s.inventory_sku_id);
              return (
                <div key={s.id} className="flex items-center justify-between rounded-lg border border-tt-border bg-tt-card px-4 py-2 text-sm">
                  <span className="font-mono">{s.section_barcode}</span>
                  <span className="text-tt-muted">→ {sku ? `#${sku.sku_number} ${sku.title}` : s.label ?? s.inventory_sku_id}</span>
                </div>
              );
            })}
          </div>
        </section>

        {/* ===== Workers (chunk 2) ===== */}
        <section className="mb-10 no-print">
          <h2 className="text-xl font-semibold mb-1">Workers ({activeWorkers.length})</h2>
          <p className="text-xs text-tt-muted mb-3">
            Picker = pick device only · Packer = pack station only · Both = either device.
            {!isOwner && ' Read-only — only store owners can edit.'}
          </p>

          {isOwner && (
            <div className="flex items-center gap-3 mb-4">
              <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Worker name"
                onKeyDown={(e) => { if (e.key === 'Enter') addWorker(); }}
                className="flex-1 max-w-xs bg-tt-input-bg border border-tt-input-border rounded-lg px-3 py-2" />
              <select value={newRole} onChange={(e) => setNewRole(e.target.value as WorkerRole)}
                className="bg-tt-input-bg border border-tt-input-border rounded-lg px-3 py-2">
                <option value="both">Both (either device)</option>
                <option value="picker">Picker (pick device)</option>
                <option value="packer">Packer (pack station)</option>
              </select>
              <button onClick={addWorker} disabled={!newName.trim()}
                className="px-4 py-2 rounded-lg bg-tt-cyan text-black font-semibold disabled:opacity-50">Add worker</button>
            </div>
          )}

          <div className="space-y-2">
            {activeWorkers.length === 0 && <div className="text-tt-muted text-sm">No active workers yet.</div>}
            {activeWorkers.map((w) => editId === w.id ? (
              <div key={w.id} className="flex items-center gap-2 rounded-lg border border-tt-cyan/40 bg-tt-card px-4 py-2 text-sm">
                <input value={editName} onChange={(e) => setEditName(e.target.value)}
                  className="flex-1 bg-tt-input-bg border border-tt-input-border rounded px-2 py-1" />
                <select value={editRole} onChange={(e) => setEditRole(e.target.value as WorkerRole)}
                  className="bg-tt-input-bg border border-tt-input-border rounded px-2 py-1">
                  <option value="both">Both</option><option value="picker">Picker</option><option value="packer">Packer</option>
                </select>
                <button onClick={saveEdit} className="text-tt-green text-xs font-semibold">Save</button>
                <button onClick={() => setEditId(null)} className="text-tt-muted text-xs">Cancel</button>
              </div>
            ) : (
              <div key={w.id} className="flex items-center justify-between rounded-lg border border-tt-border bg-tt-card px-4 py-2 text-sm">
                <div className="flex items-center gap-3">
                  <span className="font-medium">{w.name}</span>
                  <span className="text-xs px-2 py-1 rounded-full bg-tt-card-hover text-tt-muted">{roleLabel[w.role]}</span>
                </div>
                {isOwner && (
                  <div className="flex items-center gap-3">
                    <button onClick={() => startEdit(w)} className="text-tt-cyan text-xs">Edit</button>
                    <button onClick={() => setActive(w, false)} className="text-tt-red text-xs">Deactivate</button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {inactiveWorkers.length > 0 && (
            <div className="mt-4">
              <button onClick={() => setShowInactive((v) => !v)} className="text-sm text-tt-muted underline">
                {showInactive ? 'Hide' : 'Show'} inactive ({inactiveWorkers.length})
              </button>
              {showInactive && (
                <div className="space-y-2 mt-2">
                  {inactiveWorkers.map((w) => (
                    <div key={w.id} className="flex items-center justify-between rounded-lg border border-tt-border bg-tt-bg px-4 py-2 text-sm opacity-60">
                      <div className="flex items-center gap-3">
                        <span>{w.name}</span>
                        <span className="text-xs px-2 py-1 rounded-full bg-tt-card-hover text-tt-muted">{roleLabel[w.role]}</span>
                      </div>
                      {isOwner && <button onClick={() => setActive(w, true)} className="text-tt-cyan text-xs">Reactivate</button>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </section>

        {/* ===== Devices (chunk 6) ===== */}
        <section className="mb-10 no-print">
          <h2 className="text-xl font-semibold mb-1">Devices ({devices.filter((d) => d.is_active).length})</h2>
          <p className="text-xs text-tt-muted mb-3">
            Warehouse devices (fixed kind). Picker handheld → /pick · Packer station → /pack.
            {!isOwner && ' Read-only — only store owners can provision/revoke.'}
          </p>

          {isOwner && (
            <div className="flex items-center gap-3 mb-3">
              <select value={newDevKind} onChange={(e) => setNewDevKind(e.target.value as 'picker' | 'packer')}
                className="bg-tt-input-bg border border-tt-input-border rounded-lg px-3 py-2">
                <option value="picker">Picker device</option>
                <option value="packer">Packer station</option>
              </select>
              <input value={newDevLabel} onChange={(e) => setNewDevLabel(e.target.value)} placeholder="Label (e.g. Pack station 1)"
                className="flex-1 max-w-xs bg-tt-input-bg border border-tt-input-border rounded-lg px-3 py-2" />
              <button onClick={addDevice} className="px-4 py-2 rounded-lg bg-tt-cyan text-black font-semibold">Add device</button>
            </div>
          )}

          {provCode && (
            <div className="mb-4 rounded-xl border-2 border-tt-cyan/50 bg-tt-card p-4">
              <div className="text-sm font-semibold text-tt-cyan mb-1">Provisioning code — shown ONCE. Enter it on the device, then dismiss.</div>
              <textarea readOnly value={provCode} className="w-full h-24 bg-tt-input-bg border border-tt-input-border rounded p-2 font-mono text-xs break-all" />
              <div className="flex gap-2 mt-2">
                <button onClick={() => navigator.clipboard?.writeText(provCode)} className="px-3 py-1 rounded-lg bg-tt-cyan text-black text-sm font-semibold">Copy</button>
                <button onClick={() => setProvCode(null)} className="px-3 py-1 rounded-lg border border-tt-border text-tt-muted text-sm">Done (hide)</button>
              </div>
              <div className="text-xs text-tt-red mt-1">Contains the device token + session — do not share.</div>
            </div>
          )}

          <div className="space-y-2">
            {devices.length === 0 && <div className="text-tt-muted text-sm">No devices provisioned.</div>}
            {devices.map((d) => (
              <div key={d.id} className={`flex items-center justify-between rounded-lg border border-tt-border bg-tt-card px-4 py-2 text-sm ${d.is_active ? '' : 'opacity-60'}`}>
                <div className="flex items-center gap-3">
                  <span className="font-medium">{d.label || '(unlabeled)'}</span>
                  <span className="text-xs px-2 py-1 rounded-full bg-tt-card-hover text-tt-muted">{d.kind}</span>
                  {!d.is_active && <span className="text-xs px-2 py-1 rounded-full bg-tt-red/20 text-tt-red">revoked</span>}
                  <span className="text-xs text-tt-muted">last seen {d.last_seen_at ? new Date(d.last_seen_at).toLocaleString() : 'never'}</span>
                </div>
                {isOwner && (d.is_active
                  ? <button onClick={() => setDeviceActive(d, false)} className="text-tt-red text-xs">Revoke</button>
                  : <button onClick={() => setDeviceActive(d, true)} className="text-tt-cyan text-xs">Reactivate</button>)}
              </div>
            ))}
          </div>
        </section>

        {/* ===== Printable sheet (visible only when printing) ===== */}
        <div className="print-sheet">
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: '12px 0' }}>Cubicle barcodes (2 per cubicle — both sides)</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
            {cubicles.flatMap((c) => [0, 1].map((k) => (
              <div key={`${c.id}-${k}`} style={{ textAlign: 'center', padding: 8, border: '1px solid #ccc' }}
                dangerouslySetInnerHTML={{ __html: code128ToSvg(c.cubicle_barcode, { caption: `Cubicle ${c.cubicle_number}`, barHeight: 56 }) }} />
            )))}
          </div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: '20px 0 12px' }}>Section barcodes</h2>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
            {sections.map((s) => {
              const sku = skuById.get(s.inventory_sku_id);
              return (
                <div key={s.id} style={{ textAlign: 'center', padding: 8, border: '1px solid #ccc' }}
                  dangerouslySetInnerHTML={{ __html: code128ToSvg(s.section_barcode, { caption: sku ? `#${sku.sku_number} ${sku.title}`.slice(0, 28) : s.section_barcode, barHeight: 56 }) }} />
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
