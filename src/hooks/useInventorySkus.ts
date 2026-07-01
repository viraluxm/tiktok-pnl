'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useUser } from './useUser';

export interface SkuBatch {
  id: string;
  sequence: number;
  qty_remaining: number; // may be negative (oversell)
  unit_cost_cents: number | null;
}

export interface InventorySku {
  id: string;
  sku_number: number;
  barcode: string;
  title: string;
  thumbnail_path: string | null;
  thumbnail_url: string | null; // public display URL derived server-side
  shortcut_letter: string | null;
  unit_cost_cents: number | null;
  qty_on_hand: number;
  weight_oz: number | null;
  length_in: number | null;
  width_in: number | null;
  height_in: number | null;
  category: string | null;
  is_active: boolean;
  live_seller_notes: string[]; // bullets shown live in the extension overlay
  created_at: string;
  updated_at: string;
  batches: SkuBatch[]; // FIFO cost layers, oldest first
}

export interface SkuFields {
  sku_number?: number;
  title?: string;
  shortcut_letter?: string | null;
  unit_cost_cents?: number | null;
  qty_on_hand?: number;
  is_active?: boolean;
  // Write shape is the raw textarea string (one bullet per line); the server
  // canonicalizes to text[]. Read shape on InventorySku is string[].
  live_seller_notes?: string;
}

const KEY = 'inventory-skus';

function buildForm(fields: SkuFields, opts?: { image?: File | null; removeImage?: boolean }): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    fd.set(k, v === null ? '' : String(v));
  }
  if (opts?.image) fd.set('image', opts.image);
  if (opts?.removeImage) fd.set('remove_image', 'true');
  return fd;
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const json = await res.json();
    return json.error || fallback;
  } catch {
    return fallback;
  }
}

export function useInventorySkus() {
  const { user } = useUser();

  return useQuery<InventorySku[]>({
    queryKey: [KEY, user?.id],
    enabled: !!user,
    queryFn: async () => {
      const res = await fetch('/api/inventory/skus');
      if (!res.ok) throw new Error('Failed to load inventory');
      const json = await res.json();
      return json.skus ?? [];
    },
    staleTime: 30_000,
  });
}

export function useCreateSku() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ fields, image }: { fields: SkuFields; image?: File | null }) => {
      const res = await fetch('/api/inventory/skus', { method: 'POST', body: buildForm(fields, { image }) });
      if (!res.ok) throw new Error(await readError(res, 'Failed to create SKU'));
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useUpdateSku() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      fields,
      image,
      removeImage,
    }: {
      id: string;
      fields: SkuFields;
      image?: File | null;
      removeImage?: boolean;
    }) => {
      const res = await fetch(`/api/inventory/skus/${id}`, {
        method: 'PATCH',
        body: buildForm(fields, { image, removeImage }),
      });
      if (!res.ok) throw new Error(await readError(res, 'Failed to update SKU'));
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useToggleSkuActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, is_active }: { id: string; is_active: boolean }) => {
      const res = await fetch(`/api/inventory/skus/${id}/active`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active }),
      });
      if (!res.ok) throw new Error(await readError(res, 'Failed to update SKU'));
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

// Append a genuine new purchased cost layer (qty @ unit cost). NOT settle.
export function useAddBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ skuId, qty, unit_cost_cents }: { skuId: string; qty: number; unit_cost_cents: number | null }) => {
      const res = await fetch(`/api/inventory/skus/${skuId}/batches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ qty, unit_cost_cents }),
      });
      if (!res.ok) throw new Error(await readError(res, 'Failed to add batch'));
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

// Zero a negative cost layer (quantity-only; never touches recorded costs).
export function useSettleBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ skuId, batchId }: { skuId: string; batchId: string }) => {
      const res = await fetch(`/api/inventory/skus/${skuId}/batches/${batchId}/settle`, { method: 'POST' });
      if (!res.ok) throw new Error(await readError(res, 'Failed to settle batch'));
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useDeleteSku() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const res = await fetch(`/api/inventory/skus/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(await readError(res, 'Failed to delete SKU'));
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}
