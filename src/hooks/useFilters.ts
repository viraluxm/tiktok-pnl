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
