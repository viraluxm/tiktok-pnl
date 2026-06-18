'use client';

import { useMemo, useState } from 'react';
import {
  useInventorySkus,
  useCreateSku,
  useUpdateSku,
  useToggleSkuActive,
  useDeleteSku,
  type InventorySku,
  type SkuInput,
} from '@/hooks/useInventorySkus';

const fmtCents = (c: number | null) => (c == null ? '—' : `$${(c / 100).toFixed(2)}`);
const toCents = (dollars: string): number | null => {
  const t = dollars.trim();
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
};

interface FormState {
  sku_number: string;
  shortcut_letter: string;
  title: string;
  unit_cost: string; // dollars
  qty_on_hand: string;
  is_active: boolean;
}

const EMPTY: FormState = {
  sku_number: '',
  shortcut_letter: '',
  title: '',
  unit_cost: '',
  qty_on_hand: '0',
  is_active: true,
};

export default function InventorySection() {
  const { data: skus = [], isLoading } = useInventorySkus();
  const createSku = useCreateSku();
  const updateSku = useUpdateSku();
  const toggleActive = useToggleSkuActive();
  const deleteSku = useDeleteSku();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const activeSkus = useMemo(() => skus.filter((s) => s.is_active), [skus]);
  const totalValueCents = useMemo(
    () => activeSkus.reduce((sum, s) => sum + (s.unit_cost_cents ?? 0) * (s.qty_on_hand ?? 0), 0),
    [activeSkus],
  );
  const nextSkuNumber = useMemo(
    () => (skus.length ? Math.max(...skus.map((s) => s.sku_number)) + 1 : 1),
    [skus],
  );

  function openAdd() {
    setEditingId(null);
    setError(null);
    setForm({ ...EMPTY, sku_number: String(nextSkuNumber) });
    setAdding(true);
  }

  function openEdit(s: InventorySku) {
    setAdding(false);
    setError(null);
    setEditingId(s.id);
    setForm({
      sku_number: String(s.sku_number),
      shortcut_letter: s.shortcut_letter ?? '',
      title: s.title ?? '',
      unit_cost: s.unit_cost_cents != null ? (s.unit_cost_cents / 100).toFixed(2) : '',
      qty_on_hand: String(s.qty_on_hand ?? 0),
      is_active: s.is_active,
    });
  }

  function closeForm() {
    setAdding(false);
    setEditingId(null);
    setForm(EMPTY);
    setError(null);
  }

  async function submitForm() {
    setError(null);
    const input: SkuInput = {
      title: form.title.trim(),
      shortcut_letter: form.shortcut_letter.trim() || null,
      unit_cost_cents: toCents(form.unit_cost),
      qty_on_hand: form.qty_on_hand.trim() ? Math.trunc(Number(form.qty_on_hand)) : 0,
      is_active: form.is_active,
    };
    try {
      if (editingId) {
        await updateSku.mutateAsync({ id: editingId, input });
      } else {
        const n = Math.trunc(Number(form.sku_number));
        if (!Number.isFinite(n) || n <= 0) {
          setError('Enter a valid SKU number.');
          return;
        }
        await createSku.mutateAsync({ ...input, sku_number: n });
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
        {!showForm && (
          <button
            onClick={openAdd}
            className="px-5 py-2.5 rounded-lg bg-tt-cyan text-black text-sm font-semibold cursor-pointer hover:opacity-90 transition-opacity"
          >
            Add SKU
          </button>
        )}
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
          <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
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
            <Field label="Title" className="col-span-2 md:col-span-2">
              <input
                value={form.title}
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                placeholder="Item name"
                className="input"
              />
            </Field>
            <Field label="Unit cost ($)">
              <input
                value={form.unit_cost}
                onChange={(e) => setForm((f) => ({ ...f, unit_cost: e.target.value }))}
                inputMode="decimal"
                placeholder="0.00"
                className="input tabular-nums"
              />
            </Field>
            <Field label="Qty on hand">
              <input
                value={form.qty_on_hand}
                onChange={(e) => setForm((f) => ({ ...f, qty_on_hand: e.target.value }))}
                inputMode="numeric"
                className="input tabular-nums"
              />
            </Field>
          </div>
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
            Add the items you sell, with their cost and quantity, so you can log them fast during a live auction.
          </p>
        </div>
      ) : (
        <div className="rounded-2xl border border-tt-border bg-tt-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-tt-border text-tt-muted text-xs uppercase tracking-wide">
                <th className="text-left font-medium px-4 py-3">SKU</th>
                <th className="text-left font-medium px-4 py-3">Shortcut</th>
                <th className="text-left font-medium px-4 py-3">Title</th>
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
                  <td className="px-4 py-3">{s.title || <span className="text-tt-muted">Untitled</span>}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{fmtCents(s.unit_cost_cents)}</td>
                  <td className="px-4 py-3 text-right tabular-nums">{s.qty_on_hand ?? 0}</td>
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
