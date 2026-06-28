'use client';

import { useMemo, useRef, useState } from 'react';
import {
  useInventorySkus,
  useCreateSku,
  useUpdateSku,
  useToggleSkuActive,
  useDeleteSku,
  useAddBatch,
  useSettleBatch,
  type InventorySku,
} from '@/hooks/useInventorySkus';
import { code128ToSvg } from '@/lib/barcode/code128';

const fmtCents = (c: number | null) => (c == null ? '—' : `$${(c / 100).toFixed(2)}`);

const escapeHtml = (s: string) =>
  s.replace(/[<>&]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&amp;'));

// Render a single SKU's barcode as a Code 128 SVG string. The barcode ENCODES
// inventory_skus.barcode (the value the extension scanner resolves on), never
// the sku_number. Falls back to plain text if the value has an unencodable char.
function skuBarcodeSvg(s: Pick<InventorySku, 'barcode'>, barHeight = 64): string {
  try {
    return code128ToSvg(s.barcode, { caption: '', barHeight, moduleWidth: 2 });
  } catch {
    return `<div style="font-family:monospace;font-size:10pt">${escapeHtml(s.barcode)}</div>`;
  }
}

// Two physical label sizes. Both encode inventory_skus.barcode; the pallet-rack
// label is scaled up and adds the item title.
type LabelSize = '2x1' | '6x4';

const LABEL_SPECS: Record<
  LabelSize,
  { w: string; h: string; pad: string; gap: string; barcodeH: string; svgBarHeight: number; skuSize: string; titleSize: string | null }
> = {
  // Small product label: barcode + SKU#.
  '2x1': {
    w: '2in', h: '1in', pad: '0.05in 0.08in', gap: '2px',
    barcodeH: '0.6in', svgBarHeight: 64, skuSize: '11pt', titleSize: null,
  },
  // Large pallet-rack label: barcode + SKU# + title, scaled up.
  '6x4': {
    w: '6in', h: '4in', pad: '0.35in 0.45in', gap: '0.18in',
    barcodeH: '2.4in', svgBarHeight: 140, skuSize: '40pt', titleSize: '22pt',
  },
};

// Open a print window with one label per SKU, sized per `size`. Each label
// shows the scannable Code 128 barcode (encoding inventory_skus.barcode) with
// the SKU # beneath it (and the title on the 6×4). An @page rule sizes output
// so the browser prints one correctly-dimensioned label per page.
function printSkuLabels(list: InventorySku[], size: LabelSize = '2x1') {
  if (!list.length) return;
  const win = window.open('', '_blank', 'width=560,height=520');
  if (!win) return;

  const spec = LABEL_SPECS[size];

  const labels = list
    .map((s) => {
      const title =
        spec.titleSize && s.title ? `<div class="title">${escapeHtml(s.title)}</div>` : '';
      return (
        `<div class="label"><div class="bc">${skuBarcodeSvg(s, spec.svgBarHeight)}</div>` +
        `<div class="sku">SKU ${escapeHtml(String(s.sku_number))}</div>${title}</div>`
      );
    })
    .join('');

  win.document.write(
    `<!doctype html><html><head><title>SKU labels</title><style>` +
      `@page{size:${spec.w} ${spec.h};margin:0}` +
      `html,body{margin:0;padding:0;background:#fff}` +
      `.label{width:${spec.w};height:${spec.h};box-sizing:border-box;padding:${spec.pad};` +
      `display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${spec.gap};` +
      `overflow:hidden;page-break-after:always;break-after:page}` +
      `.label:last-child{page-break-after:auto;break-after:auto}` +
      `.bc{display:flex;align-items:center;justify-content:center;width:100%}` +
      `.bc svg{height:${spec.barcodeH};width:auto;max-width:100%}` +
      `.sku{font-family:monospace;font-weight:700;font-size:${spec.skuSize};line-height:1}` +
      (spec.titleSize
        ? `.title{font-family:system-ui,sans-serif;font-weight:600;font-size:${spec.titleSize};` +
          `text-align:center;max-width:100%;line-height:1.1;overflow:hidden}`
        : '') +
      `</style></head><body>${labels}` +
      `<script>window.onload=function(){window.focus();window.print();}<\/script></body></html>`,
  );
  win.document.close();
}
const toCents = (dollars: string): number | null => {
  const t = dollars.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

// Downscale to a small JPEG before upload so stored thumbnails load fast.
// Falls back to the original file if anything goes wrong.
async function downscale(file: File, max = 512, quality = 0.82): Promise<File> {
  try {
    const bitmapUrl = URL.createObjectURL(file);
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = bitmapUrl;
    });
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const w = Math.max(1, Math.round(img.width * scale));
    const h = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas context');
    ctx.drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(bitmapUrl);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) throw new Error('toBlob failed');
    return new File([blob], 'thumb.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}

interface FormState {
  sku_number: string;
  shortcut_letter: string;
  title: string;
  unit_cost: string; // dollars
  qty_on_hand: string;
  is_active: boolean;
  live_seller_notes: string; // textarea, one bullet per line
}

const EMPTY: FormState = {
  sku_number: '',
  shortcut_letter: '',
  title: '',
  unit_cost: '',
  qty_on_hand: '0',
  is_active: true,
  live_seller_notes: '',
};

export default function InventorySection() {
  const { data: skus = [], isLoading } = useInventorySkus();
  const createSku = useCreateSku();
  const updateSku = useUpdateSku();
  const toggleActive = useToggleSkuActive();
  const deleteSku = useDeleteSku();
  const addBatch = useAddBatch();
  const settleBatch = useSettleBatch();

  // Add-batch form inputs (lives in the Edit panel; the SKU is `editingId`).
  const [batchQty, setBatchQty] = useState('');
  const [batchCost, setBatchCost] = useState('');
  const [batchErr, setBatchErr] = useState<string | null>(null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [labelSize, setLabelSize] = useState<LabelSize>('2x1');

  // Image state for the form.
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [existingThumbUrl, setExistingThumbUrl] = useState<string | null>(null);
  const [removeImage, setRemoveImage] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const activeSkus = useMemo(() => skus.filter((s) => s.is_active), [skus]);
  const totalValueCents = useMemo(
    () => activeSkus.reduce((sum, s) => sum + (s.unit_cost_cents ?? 0) * (s.qty_on_hand ?? 0), 0),
    [activeSkus],
  );
  const nextSkuNumber = useMemo(
    () => (skus.length ? Math.max(...skus.map((s) => s.sku_number)) + 1 : 1),
    [skus],
  );

  // SKU currently open in the edit form (for the single-label barcode preview).
  const editingSku = useMemo(
    () => (editingId ? skus.find((s) => s.id === editingId) ?? null : null),
    [editingId, skus],
  );
  const editBarcodeSvg = useMemo(
    () => (editingSku ? skuBarcodeSvg(editingSku, 56) : ''),
    [editingSku],
  );

  // Bulk-print selection, in table order.
  const selectedSkus = useMemo(
    () => skus.filter((s) => selectedIds.has(s.id)),
    [skus, selectedIds],
  );
  const allSelected = skus.length > 0 && selectedIds.size === skus.length;

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds((prev) => (prev.size === skus.length ? new Set() : new Set(skus.map((s) => s.id))));
  }

  function clearImageState() {
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImageFile(null);
    setImagePreview(null);
    setExistingThumbUrl(null);
    setRemoveImage(false);
    if (fileRef.current) fileRef.current.value = '';
  }

  function openAdd() {
    setEditingId(null);
    setError(null);
    clearImageState();
    setForm({ ...EMPTY, sku_number: String(nextSkuNumber) });
    setAdding(true);
  }

  function openEdit(s: InventorySku) {
    setAdding(false);
    setError(null);
    clearImageState();
    setBatchQty(''); setBatchCost(''); setBatchErr(null);
    setExistingThumbUrl(s.thumbnail_url);
    setEditingId(s.id);
    setForm({
      sku_number: String(s.sku_number),
      shortcut_letter: s.shortcut_letter ?? '',
      title: s.title ?? '',
      unit_cost: s.unit_cost_cents != null ? (s.unit_cost_cents / 100).toFixed(2) : '',
      qty_on_hand: String(s.qty_on_hand ?? 0),
      is_active: s.is_active,
      live_seller_notes: (s.live_seller_notes ?? []).join('\n'),
    });
  }

  function closeForm() {
    clearImageState();
    setAdding(false);
    setEditingId(null);
    setForm(EMPTY);
    setError(null);
    setBatchQty(''); setBatchCost(''); setBatchErr(null);
  }

  async function onPickImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const small = await downscale(file);
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImageFile(small);
    setImagePreview(URL.createObjectURL(small));
    setRemoveImage(false);
  }

  function onRemoveImage() {
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImageFile(null);
    setImagePreview(null);
    setRemoveImage(true);
    if (fileRef.current) fileRef.current.value = '';
  }

  const shownPreview = imagePreview ?? (removeImage ? null : existingThumbUrl);
  const hasImage = !!shownPreview;

  async function submitForm() {
    setError(null);
    // Shared editable fields. qty_on_hand and unit cost are NOT here for edits —
    // under FIFO they're batch-derived (qty = Σ layers, cost is per-layer), so
    // writing them directly would desync from Σ batches. They're managed via
    // Add batch / Settle. They ARE sent on create, to seed the SKU's first batch.
    const common = {
      title: form.title.trim(),
      shortcut_letter: form.shortcut_letter.trim() || null,
      is_active: form.is_active,
      live_seller_notes: form.live_seller_notes,
    };
    try {
      if (editingId) {
        await updateSku.mutateAsync({ id: editingId, fields: common, image: imageFile, removeImage });
      } else {
        const n = Math.trunc(Number(form.sku_number));
        if (!Number.isFinite(n) || n <= 0) {
          setError('Enter a valid SKU number.');
          return;
        }
        const created = await createSku.mutateAsync({
          fields: {
            ...common,
            sku_number: n,
            unit_cost_cents: toCents(form.unit_cost),
            qty_on_hand: form.qty_on_hand.trim() ? Math.trunc(Number(form.qty_on_hand)) : 0,
          },
          image: imageFile,
        });
        // Auto-print the new SKU's label (server-generated barcode must exist).
        const newSku = created?.sku as InventorySku | undefined;
        if (newSku?.barcode) printSkuLabels([newSku], labelSize);
      }
      closeForm();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong.');
    }
  }

  async function onDelete(id: string) {
    setError(null);
    try {
      await deleteSku.mutateAsync(id);
      setConfirmDeleteId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to delete SKU.');
      setConfirmDeleteId(null);
    }
  }

  async function submitAddBatch(skuId: string) {
    const qty = Math.trunc(Number(batchQty));
    if (!Number.isFinite(qty) || qty < 0) { setBatchErr('Qty must be a non-negative whole number'); return; }
    const cost = batchCost.trim() === '' ? null : Math.round(Number(batchCost) * 100);
    if (cost != null && !Number.isFinite(cost)) { setBatchErr('Cost must be a number'); return; }
    setBatchErr(null);
    try {
      await addBatch.mutateAsync({ skuId, qty, unit_cost_cents: cost });
      setBatchQty(''); setBatchCost('');
    } catch (e) {
      setBatchErr(e instanceof Error ? e.message : 'Failed to add batch');
    }
  }

  async function onSettle(skuId: string, batchId: string) {
    setBatchErr(null);
    try {
      await settleBatch.mutateAsync({ skuId, batchId });
    } catch (e) {
      setBatchErr(e instanceof Error ? e.message : 'Failed to settle batch');
    }
  }

  const saving = createSku.isPending || updateSku.isPending;
  const showForm = adding || editingId !== null;

  return (
    <div>
      {/* Summary + primary action */}
      <div className="flex items-end justify-between gap-4 mb-6">
        <div>
          <div className="text-sm text-tt-muted">Inventory value (active)</div>
          <div className="text-2xl font-bold tabular-nums">{fmtCents(totalValueCents)}</div>
          <div className="text-xs text-tt-muted mt-1">
            {activeSkus.length} active {activeSkus.length === 1 ? 'SKU' : 'SKUs'}
            {skus.length > activeSkus.length ? ` · ${skus.length - activeSkus.length} inactive` : ''}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-tt-muted">
            Label
            <select
              value={labelSize}
              onChange={(e) => setLabelSize(e.target.value as LabelSize)}
              className="rounded-lg border border-tt-border bg-tt-input-bg px-2 py-1.5 text-xs text-tt-text cursor-pointer outline-none"
            >
              <option value="2x1">2×1 (product)</option>
              <option value="6x4">6×4 (pallet rack)</option>
            </select>
          </label>
          {selectedSkus.length > 0 && (
            <button
              onClick={() => printSkuLabels(selectedSkus, labelSize)}
              className="px-4 py-2.5 rounded-lg border border-tt-border text-sm font-semibold text-tt-text cursor-pointer hover:bg-tt-card-hover transition-colors"
            >
              Print labels ({selectedSkus.length})
            </button>
          )}
          {!showForm && (
            <button
              onClick={openAdd}
              className="px-5 py-2.5 rounded-lg bg-tt-cyan text-black text-sm font-semibold cursor-pointer hover:opacity-90 transition-opacity"
            >
              Add SKU
            </button>
          )}
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-tt-red/40 bg-tt-red/10 px-4 py-2.5 text-sm text-tt-red">
          {error}
        </div>
      )}

      {/* Inline add/edit form (not a modal) */}
      {showForm && (
        <div className="mb-6 rounded-2xl border border-tt-border bg-tt-card p-5">
          <div className="text-sm font-semibold mb-4">
            {editingId ? `Edit SKU ${form.sku_number}` : 'Add SKU'}
          </div>

          <div className="flex gap-5">
            {/* Image uploader */}
            <div className="shrink-0">
              <span className="block text-xs text-tt-muted mb-1.5">Image</span>
              <div className="w-24 h-24 rounded-lg border border-tt-border bg-tt-input-bg overflow-hidden flex items-center justify-center">
                {hasImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={shownPreview!} alt="" className="w-full h-full object-cover" />
                ) : (
                  <span className="text-tt-muted text-xs">No image</span>
                )}
              </div>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp"
                onChange={onPickImage}
                className="hidden"
              />
              <div className="flex flex-col gap-1.5 mt-2">
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  className="px-3 py-1.5 rounded-lg border border-tt-border text-xs text-tt-text cursor-pointer hover:bg-tt-card-hover transition-colors"
                >
                  {hasImage ? 'Replace Image' : 'Upload Image'}
                </button>
                {hasImage && (
                  <button
                    type="button"
                    onClick={onRemoveImage}
                    className="px-3 py-1.5 rounded-lg text-xs text-tt-muted cursor-pointer hover:text-tt-red transition-colors"
                  >
                    Remove
                  </button>
                )}
              </div>
            </div>

            {/* Barcode + single label print (edit only) */}
            {editingSku && (
              <div className="shrink-0">
                <span className="block text-xs text-tt-muted mb-1.5">Label</span>
                <div className="rounded-lg border border-tt-border bg-white px-3 py-2 flex flex-col items-center justify-center">
                  <div
                    className="[&_svg]:h-12 [&_svg]:w-auto"
                    // eslint-disable-next-line react/no-danger
                    dangerouslySetInnerHTML={{ __html: editBarcodeSvg }}
                  />
                  <span className="mt-1 font-mono text-xs font-bold text-black">
                    SKU {editingSku.sku_number}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => printSkuLabels([editingSku], labelSize)}
                  className="mt-2 w-full px-3 py-1.5 rounded-lg border border-tt-border text-xs text-tt-text cursor-pointer hover:bg-tt-card-hover transition-colors"
                >
                  Print label
                </button>
              </div>
            )}

            {/* Fields */}
            <div className="flex-1 grid grid-cols-2 md:grid-cols-4 gap-3 content-start">
              <Field label="SKU #">
                <input
                  value={form.sku_number}
                  onChange={(e) => setForm((f) => ({ ...f, sku_number: e.target.value }))}
                  disabled={!!editingId}
                  inputMode="numeric"
                  className="input disabled:opacity-50"
                />
              </Field>
              <Field label="Shortcut">
                <input
                  value={form.shortcut_letter}
                  onChange={(e) => setForm((f) => ({ ...f, shortcut_letter: e.target.value.toUpperCase() }))}
                  maxLength={2}
                  placeholder="A"
                  className="input uppercase"
                />
              </Field>
              <Field label="Title" className="col-span-2">
                <input
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  placeholder="Item name"
                  className="input"
                />
              </Field>
              {editingId ? (
                <>
                  {/* FIFO: cost is per-layer and qty = Σ layers — both read-only here,
                      managed via the cost layers below. */}
                  <Field label="Unit cost">
                    <div className="input flex items-center text-tt-muted" title="Cost is tracked per layer — see Cost layers below">
                      Per layer ↓
                    </div>
                  </Field>
                  <Field label="Qty on hand (Σ layers)">
                    <div className={`input flex items-center justify-end tabular-nums ${(editingSku?.qty_on_hand ?? 0) < 0 ? 'text-tt-red font-semibold' : 'text-tt-muted'}`}>
                      {editingSku?.qty_on_hand ?? 0}
                    </div>
                  </Field>
                </>
              ) : (
                <>
                  <Field label="Unit cost ($)">
                    <input
                      value={form.unit_cost}
                      onChange={(e) => setForm((f) => ({ ...f, unit_cost: e.target.value }))}
                      inputMode="decimal"
                      placeholder="0.00"
                      className="input tabular-nums"
                    />
                  </Field>
                  <Field label="Starting qty">
                    <input
                      value={form.qty_on_hand}
                      onChange={(e) => setForm((f) => ({ ...f, qty_on_hand: e.target.value }))}
                      inputMode="numeric"
                      className="input tabular-nums"
                    />
                  </Field>
                </>
              )}
              <Field label="Live seller talking points" className="col-span-2 md:col-span-4">
                <textarea
                  value={form.live_seller_notes}
                  onChange={(e) => setForm((f) => ({ ...f, live_seller_notes: e.target.value }))}
                  rows={3}
                  placeholder="One bullet per line — shown in the live overlay when this SKU is scanned"
                  className="input resize-y"
                />
              </Field>
            </div>
          </div>

          {/* Cost layers (FIFO) — the home for managing a SKU's stock + cost. */}
          {editingSku && (
            <div className="mt-5 rounded-xl border border-tt-border bg-tt-bg/40 p-4">
              <div className="flex items-baseline justify-between mb-2">
                <span className="text-xs font-semibold text-tt-text">Cost layers (FIFO)</span>
                <span className="text-[11px] text-tt-muted">a sale draws fully from the oldest layer that can cover it · total = Σ layers = {editingSku.qty_on_hand ?? 0}</span>
              </div>
              <div className="space-y-1.5 mb-3">
                {editingSku.batches.length === 0 ? (
                  <div className="text-xs text-tt-muted">No layers.</div>
                ) : (
                  editingSku.batches.map((b) => (
                    <div key={b.id} className="flex items-center gap-3 text-sm">
                      <span className="text-tt-muted tabular-nums w-8">#{b.sequence}</span>
                      <span className={`tabular-nums w-16 text-right ${b.qty_remaining < 0 ? 'text-tt-red font-semibold' : 'text-tt-text'}`}>{b.qty_remaining}</span>
                      <span className="text-tt-muted">@ {fmtCents(b.unit_cost_cents)}</span>
                      {b.qty_remaining < 0 && (
                        <button
                          type="button"
                          onClick={() => onSettle(editingSku.id, b.id)}
                          disabled={settleBatch.isPending}
                          className="ml-1 px-2 py-0.5 rounded-md border border-tt-red/50 text-tt-red text-xs font-medium cursor-pointer hover:bg-tt-red/10 disabled:opacity-50"
                          title={`Add ${-b.qty_remaining} unit(s) to bring this layer to 0 — quantity only, never changes a recorded sale cost`}
                        >
                          Settle ({-b.qty_remaining} → 0)
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
              <div className="flex flex-wrap items-end gap-2 border-t border-tt-border pt-3">
                <div className="flex flex-col">
                  <span className="text-[10px] uppercase tracking-wide text-tt-muted mb-0.5">Add batch — new purchased stock</span>
                  <div className="flex items-center gap-2">
                    <input
                      type="number" min={0} placeholder="Qty" value={batchQty}
                      onChange={(e) => setBatchQty(e.target.value)}
                      className="w-20 rounded-lg border border-tt-border bg-tt-input-bg px-2 py-1 text-sm text-tt-text outline-none tabular-nums"
                    />
                    <input
                      inputMode="decimal" placeholder="Unit cost $" value={batchCost}
                      onChange={(e) => setBatchCost(e.target.value)}
                      className="w-28 rounded-lg border border-tt-border bg-tt-input-bg px-2 py-1 text-sm text-tt-text outline-none tabular-nums"
                    />
                    <button
                      type="button"
                      onClick={() => submitAddBatch(editingSku.id)}
                      disabled={addBatch.isPending || batchQty.trim() === ''}
                      className="px-3 py-1 rounded-lg bg-tt-cyan text-black text-sm font-semibold cursor-pointer hover:opacity-90 disabled:opacity-40"
                    >
                      {addBatch.isPending ? 'Adding…' : 'Add batch'}
                    </button>
                  </div>
                </div>
                <span className="text-[10px] text-tt-muted">Add batch = new stock at a price (adds units). Settle = zero a negative layer (adds the deficit only, never changes cost).</span>
                {batchErr && <span className="text-tt-red text-xs w-full">{batchErr}</span>}
              </div>
            </div>
          )}

          <div className="flex items-center gap-3 mt-4">
            <label className="flex items-center gap-2 text-sm text-tt-muted cursor-pointer">
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
                className="accent-tt-cyan"
              />
              Active
            </label>
            <div className="ml-auto flex gap-2">
              <button
                onClick={closeForm}
                className="px-4 py-2 rounded-lg border border-tt-border text-sm text-tt-muted cursor-pointer hover:bg-tt-card-hover transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={submitForm}
                disabled={saving}
                className="px-4 py-2 rounded-lg bg-tt-cyan text-black text-sm font-semibold cursor-pointer hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add SKU'}
              </button>
            </div>
          </div>
          <style jsx>{`
            .input {
              width: 100%;
              background: var(--color-tt-input-bg);
              border: 1px solid var(--color-tt-input-border);
              border-radius: 8px;
              padding: 8px 10px;
              font-size: 14px;
              color: var(--color-tt-text);
              outline: none;
            }
            .input:focus {
              border-color: var(--color-tt-input-focus);
            }
          `}</style>
        </div>
      )}

      {/* Table */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16 text-tt-muted">
          <div className="w-5 h-5 border-2 border-tt-muted border-t-transparent rounded-full animate-spin mr-3" />
          Loading inventory…
        </div>
      ) : skus.length === 0 ? (
        <div className="rounded-2xl border border-tt-border bg-tt-card py-16 text-center">
          <div className="text-tt-text font-medium">No SKUs yet</div>
          <p className="text-sm text-tt-muted mt-2 max-w-sm mx-auto">
            Add the items you sell, with their cost, quantity, and a photo, so you can log them fast during a live auction.
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-tt-border bg-tt-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-tt-border text-tt-muted text-xs uppercase tracking-wide">
                <th className="px-4 py-3 w-px">
                  <input
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    aria-label="Select all SKUs"
                    title="Select all"
                    className="accent-tt-cyan align-middle cursor-pointer"
                  />
                </th>
                <th className="text-left font-medium px-4 py-3">SKU</th>
                <th className="text-left font-medium px-4 py-3">Shortcut</th>
                <th className="text-left font-medium px-4 py-3">Item</th>
                <th className="text-right font-medium px-4 py-3">Unit cost</th>
                <th className="text-right font-medium px-4 py-3">Qty</th>
                <th className="text-center font-medium px-4 py-3">Active</th>
                <th className="text-right font-medium px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody>
              {skus.map((s) => (
                <tr
                  key={s.id}
                  className={`border-b border-tt-border last:border-0 ${s.is_active ? '' : 'opacity-50'}`}
                >
                  <td className="px-4 py-3 w-px">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(s.id)}
                      onChange={() => toggleSelected(s.id)}
                      aria-label={`Select SKU ${s.sku_number}`}
                      className="accent-tt-cyan align-middle cursor-pointer"
                    />
                  </td>
                  <td className="px-4 py-3 font-mono text-tt-muted">{s.sku_number}</td>
                  <td className="px-4 py-3">
                    {s.shortcut_letter ? (
                      <span className="inline-flex items-center justify-center min-w-6 h-6 px-1.5 rounded-md bg-tt-cyan/15 text-tt-cyan text-xs font-bold">
                        {s.shortcut_letter}
                      </span>
                    ) : (
                      <span className="text-tt-muted">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3 min-w-0">
                      <Thumb url={s.thumbnail_url} />
                      <span className="min-w-0 truncate">
                        {s.title || <span className="text-tt-muted">Untitled</span>}
                      </span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmtCents(s.unit_cost_cents)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">
                    {(() => {
                      const negative = (s.qty_on_hand ?? 0) < 0 || s.batches.some((b) => b.qty_remaining < 0);
                      return (
                        <span className={negative ? 'text-tt-red font-semibold' : 'text-tt-text'}>
                          {s.qty_on_hand ?? 0}
                          <span className="ml-1.5 text-[10px] font-normal text-tt-muted" title="cost layers — manage in Edit">{s.batches.length}L</span>
                        </span>
                      );
                    })()}
                  </td>
                  <td className="px-4 py-3 text-center">
                    <button
                      onClick={() => toggleActive.mutate({ id: s.id, is_active: !s.is_active })}
                      className="text-xs font-medium cursor-pointer hover:underline"
                      title={s.is_active ? 'Click to deactivate' : 'Click to activate'}
                    >
                      <span className={s.is_active ? 'text-tt-green' : 'text-tt-muted'}>
                        {s.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </button>
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    {confirmDeleteId === s.id ? (
                      <span className="inline-flex items-center gap-2">
                        <span className="text-xs text-tt-muted">Delete?</span>
                        <button onClick={() => onDelete(s.id)} className="text-xs text-tt-red font-medium cursor-pointer hover:underline">Yes</button>
                        <button onClick={() => setConfirmDeleteId(null)} className="text-xs text-tt-muted cursor-pointer hover:underline">No</button>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-3">
                        <button onClick={() => openEdit(s)} className="text-xs text-tt-cyan cursor-pointer hover:underline">Edit</button>
                        <button onClick={() => setConfirmDeleteId(s.id)} className="text-xs text-tt-muted cursor-pointer hover:underline">Delete</button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Field({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block ${className}`}>
      <span className="block text-xs text-tt-muted mb-1.5">{label}</span>
      {children}
    </label>
  );
}

// Small fixed-size thumbnail with a clean empty/placeholder state.
function Thumb({ url }: { url: string | null }) {
  return (
    <div className="w-9 h-9 shrink-0 rounded-md border border-tt-border bg-tt-input-bg overflow-hidden flex items-center justify-center">
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={url}
          alt=""
          className="w-full h-full object-cover"
          onError={(e) => {
            e.currentTarget.style.display = 'none';
          }}
        />
      ) : (
        <span className="text-tt-muted text-[10px]">—</span>
      )}
    </div>
  );
}
