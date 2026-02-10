'use client';

import { useState, useCallback } from 'react';
import type { FilterState } from '@/types';

export function useFilters() {
  const [filters, setFilters] = useState<FilterState>({
    dateFrom: null,
    dateTo: null,
    productId: 'all',
  });

  const setQuickFilter = useCallback((days: number | 'all') => {
    if (days === 'all') {
      setFilters((prev) => ({ ...prev, dateFrom: null, dateTo: null }));
    } else if (days === 0) {
      // Today
      const today = new Date().toISOString().split('T')[0];
      setFilters((prev) => ({ ...prev, dateFrom: today, dateTo: today }));
    } else if (days === 1) {
      // Yesterday
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      const yStr = yesterday.toISOString().split('T')[0];
      setFilters((prev) => ({ ...prev, dateFrom: yStr, dateTo: yStr }));
    } else {
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - days);
      setFilters((prev) => ({
        ...prev,
        dateFrom: from.toISOString().split('T')[0],
        dateTo: to.toISOString().split('T')[0],
      }));
    }
  }, []);

  const setDateFrom = useCallback((date: string | null) => {
    setFilters((prev) => ({ ...prev, dateFrom: date }));
  }, []);

  const setDateTo = useCallback((date: string | null) => {
    setFilters((prev) => ({ ...prev, dateTo: date }));
  }, []);

  const setProductId = useCallback((productId: string) => {
    setFilters((prev) => ({ ...prev, productId }));
  }, []);

  return { filters, setQuickFilter, setDateFrom, setDateTo, setProductId };
}
