'use client';

import { useState, useMemo } from 'react';
import { generateDemoEntries, DEMO_USER_ID } from '@/lib/demo/data';
import type { Entry, FilterState } from '@/types';

/**
 * Drop-in replacement for useEntries() when in demo mode.
 * Returns the same interface but backed by in-memory mock data.
 */
export function useDemoEntries(filters: FilterState) {
  const [allEntries, setAllEntries] = useState<Entry[]>(() => generateDemoEntries());

  const entries = useMemo(() => {
    let filtered = [...allEntries];

    if (filters.dateFrom) {
      filtered = filtered.filter((e) => e.date >= filters.dateFrom!);
    }
    if (filters.dateTo) {
      filtered = filtered.filter((e) => e.date <= filters.dateTo!);
    }
    if (filters.productId !== 'all') {
      filtered = filtered.filter((e) => e.product_id === filters.productId);
    }

    return filtered;
  }, [allEntries, filters]);

  const addEntry = {
    mutate: (entry: {
      product_id: string;
      date: string;
      gmv: number;
      videos_posted: number;
      views: number;
      shipping: number;
      affiliate: number;
      ads: number;
    }) => {
      const product = allEntries.find(e => e.product_id === entry.product_id)?.product;
      const newEntry: Entry = {
        id: `demo-entry-new-${Date.now()}`,
        user_id: DEMO_USER_ID,
        ...entry,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        source: 'manual',
        product: product || undefined,
      };
      setAllEntries((prev) => [newEntry, ...prev]);
    },
    mutateAsync: async (entry: {
      product_id: string;
      date: string;
      gmv: number;
      videos_posted: number;
      views: number;
      shipping: number;
      affiliate: number;
      ads: number;
    }) => {
      const product = allEntries.find(e => e.product_id === entry.product_id)?.product;
      const newEntry: Entry = {
        id: `demo-entry-new-${Date.now()}`,
        user_id: DEMO_USER_ID,
        ...entry,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        source: 'manual',
        product: product || undefined,
      };
      setAllEntries((prev) => [newEntry, ...prev]);
      return newEntry;
    },
    isPending: false,
  };

  const updateEntry = {
    mutate: ({ id, ...fields }: { id: string; [key: string]: unknown }) => {
      setAllEntries((prev) =>
        prev.map((e) =>
          e.id === id ? { ...e, ...fields, updated_at: new Date().toISOString() } : e
        )
      );
    },
    isPending: false,
  };

  const deleteEntry = {
    mutate: (id: string) => {
      setAllEntries((prev) => prev.filter((e) => e.id !== id));
    },
    isPending: false,
  };

  const bulkInsert = {
    mutate: (newEntries: Array<{
      product_id: string;
      date: string;
      gmv: number;
      videos_posted: number;
      views: number;
      shipping: number;
      affiliate: number;
      ads: number;
    }>) => {
      const created = newEntries.map((entry, i) => {
        const product = allEntries.find(e => e.product_id === entry.product_id)?.product;
        return {
          id: `demo-entry-bulk-${Date.now()}-${i}`,
          user_id: DEMO_USER_ID,
          ...entry,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          source: 'manual' as const,
          product: product || undefined,
        };
      });
      setAllEntries((prev) => [...created, ...prev]);
    },
    isPending: false,
  };

  return {
    entries,
    isLoading: false,
    addEntry,
    updateEntry,
    deleteEntry,
    bulkInsert,
  };
}
