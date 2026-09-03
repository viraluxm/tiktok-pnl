'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useUser } from './useUser';
import type { SectionSide } from '@/lib/mapping/shape';

const KEY = 'inventory-mapping';

export interface MappingRack {
  id: string;
  name: string;
  grid_row: number;
  grid_col: number;
  shelf_count: number;
  route_pos_a: number | null;
  route_pos_b: number | null;
  is_active: boolean;
}

export interface MappingSlot {
  id: string;
  rack_id: string;
  shelf_index: number;
  section_index: number;
  side: SectionSide;
  slot_code: string;
  inventory_sku_id: string | null;
  is_active: boolean;
}

export interface MappingSku {
  id: string;
  sku_number: number;
  title: string;
  barcode: string;
  thumbnail_url: string | null;
  /** May be negative (oversell); <= 0 means nothing is on the shelf. */
  qty_on_hand: number;
}

export interface MappingData {
  racks: MappingRack[];
  slots: MappingSlot[];
  skus: MappingSku[];
}

/**
 * A 409 from these endpoints is not a failure — it is the server reporting what a
 * destructive change would cost so the UI can confirm it. The details ride on the thrown
 * error rather than being flattened into a message string.
 */
export class NeedsConfirmation extends Error {
  assignedLost: number;
  skusUnmapped: string[];
  constructor(message: string, assignedLost: number, skusUnmapped: string[]) {
    super(message);
    this.name = 'NeedsConfirmation';
    this.assignedLost = assignedLost;
    this.skusUnmapped = skusUnmapped;
  }
}

async function readError(res: Response, fallback: string): Promise<never> {
  let payload: Record<string, unknown> = {};
  try { payload = await res.json(); } catch { /* non-JSON body */ }
  const message = typeof payload.error === 'string' ? payload.error : fallback;
  if (res.status === 409 && payload.needs_confirmation) {
    throw new NeedsConfirmation(
      message,
      Number(payload.assigned_lost ?? 0),
      Array.isArray(payload.skus_unmapped) ? (payload.skus_unmapped as string[]) : [],
    );
  }
  throw new Error(message);
}

export function useMapping() {
  const { user } = useUser();
  return useQuery<MappingData>({
    queryKey: [KEY, user?.id],
    enabled: !!user,
    queryFn: async () => {
      const res = await fetch('/api/inventory/mapping');
      if (!res.ok) await readError(res, 'Failed to load mapping');
      return res.json();
    },
    staleTime: 30_000,
  });
}

/** Create a rack. Shelves only — the name is assigned server-side, sections are added after. */
export function useCreateRack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (fields: { grid_row: number; grid_col: number; shelf_count: number }) => {
      const res = await fetch('/api/inventory/mapping/racks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      if (!res.ok) await readError(res, 'Failed to create rack');
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useUpdateRack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...fields }: {
      id: string;
      grid_row?: number;
      grid_col?: number;
      shelf_count?: number;
      route_pos_a?: number | null;
      route_pos_b?: number | null;
      is_active?: boolean;
      confirm_destructive?: boolean;
    }) => {
      const res = await fetch(`/api/inventory/mapping/racks/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      if (!res.ok) await readError(res, 'Failed to update rack');
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useDeleteRack() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, confirm }: { id: string; confirm?: boolean }) => {
      const res = await fetch(
        `/api/inventory/mapping/racks/${id}${confirm ? '?confirm=1' : ''}`,
        { method: 'DELETE' },
      );
      if (!res.ok) await readError(res, 'Failed to delete rack');
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

/** Divide one shelf once more. The section number is assigned server-side. */
export function useAddSection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (fields: { rack_id: string; shelf_index: number; side: SectionSide }) => {
      const res = await fetch('/api/inventory/mapping/slots', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fields),
      });
      if (!res.ok) await readError(res, 'Failed to add section');
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useDeleteSection() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ slotId, confirm }: { slotId: string; confirm?: boolean }) => {
      const res = await fetch(
        `/api/inventory/mapping/slots/${slotId}${confirm ? '?confirm=1' : ''}`,
        { method: 'DELETE' },
      );
      if (!res.ok) await readError(res, 'Failed to remove section');
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

/**
 * Change which aisle(s) a section is picked from. Setting 'AB' is the "picked from both
 * sides" action; it can be refused when the aisle being gained is already full.
 */
export function useSetSectionSide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ slotId, side }: { slotId: string; side: SectionSide }) => {
      const res = await fetch(`/api/inventory/mapping/slots/${slotId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ side }),
      });
      if (!res.ok) await readError(res, 'Failed to change the section side');
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

/** Insert a shelf above or below an existing one, renumbering everything that follows. */
export function useInsertShelf() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (fields: { rackId: string; at: number; position: 'above' | 'below' }) => {
      const res = await fetch(`/api/inventory/mapping/racks/${fields.rackId}/shelves`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ at: fields.at, position: fields.position }),
      });
      if (!res.ok) await readError(res, 'Failed to add the shelf');
      return res.json() as Promise<{ new_shelf_index: number; labels_to_reprint: number }>;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useRemoveShelf() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ rackId, at, confirm }: { rackId: string; at: number; confirm?: boolean }) => {
      const res = await fetch(
        `/api/inventory/mapping/racks/${rackId}/shelves?at=${at}${confirm ? '&confirm=1' : ''}`,
        { method: 'DELETE' },
      );
      if (!res.ok) await readError(res, 'Failed to remove the shelf');
      return res.json() as Promise<{ labels_to_reprint: number }>;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}

export function useAssignSlot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ slotId, skuId }: { slotId: string; skuId: string | null }) => {
      const res = await fetch(`/api/inventory/mapping/slots/${slotId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inventory_sku_id: skuId }),
      });
      if (!res.ok) await readError(res, 'Failed to assign section');
      return res.json();
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: [KEY] }),
  });
}
