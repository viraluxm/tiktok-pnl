'use client';

import { useState, useCallback } from 'react';
import type { FilterState } from '@/types';

export function useFilters() {
  // Default to "all" — shows all data regardless of date
  const [filters, setFilters] = useState<FilterState>({
    dateFrom: null,
    dateTo: null,
    productId: 'all',
  });

  const setQuickFilter = useCallback((days: number | 'all') => {
    if (days === 'all') {
      setFilters((prev: FilterState) => ({ ...prev, dateFrom: null, dateTo: null }));
      return;
    }

    // Always use actual current date for Today/Yesterday/7d/30d
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    if (days === 0) {
      setFilters((prev: FilterState) => ({ ...prev, dateFrom: todayStr, dateTo: todayStr }));
    } else if (days === 1) {
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const yStr = yesterday.toISOString().split('T')[0];
      setFilters((prev: FilterState) => ({ ...prev, dateFrom: yStr, dateTo: yStr }));
    } else {
      const from = new Date(now);
      from.setDate(from.getDate() - days);
      setFilters((prev: FilterState) => ({
        ...prev,
        dateFrom: from.toISOString().split('T')[0],
        dateTo: todayStr,
      }));
    }
  }, []);

  const setDateFrom = useCallback((date: string | null) => {
    setFilters((prev: FilterState) => ({ ...prev, dateFrom: date }));
  }, []);

  const setDateTo = useCallback((date: string | null) => {
    setFilters((prev: FilterState) => ({ ...prev, dateTo: date }));
  }, []);

  const setProductId = useCallback((productId: string) => {
    setFilters((prev: FilterState) => ({ ...prev, productId }));
  }, []);

  return { filters, setQuickFilter, setDateFrom, setDateTo, setProductId };
}
