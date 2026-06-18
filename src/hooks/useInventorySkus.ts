'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useUser } from './useUser';

export interface InventorySku {
  id: string;
  sku_number: number;
  barcode: string;
  title: string;
  shortcut_letter: string | null;
  unit_cost_cents: number | null;
  qty_on_hand: number;
  weight_oz: number | null;
  length_in: number | null;
  width_in: number | null;
  height_in: number | null;
  category: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface SkuInput {
  sku_number?: number;
  title?: string;
  shortcut_letter?: string | null;
  unit_cost_cents?: number | null;
  qty_on_hand?: number;
  weight_oz?: number | null;
  length_in?: number | null;
  width_in?: number | null;
  height_in?: number | null;
  category?: string | null;
  is_active?: boolean;
}

const KEY = 'inventory-skus';

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

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const json = await res.json();
    return json.error || fallback;
  } catch {
    return fallback;
  }
}

export function useCreateSku() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SkuInput) => {
      const res = await fetch('/api/inventory/skus', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(await readError(res, 'Failed to create SKU'));
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useUpdateSku() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: SkuInput }) => {
      const res = await fetch(`/api/inventory/skus/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
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
