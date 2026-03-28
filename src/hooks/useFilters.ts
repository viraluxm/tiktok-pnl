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

  // latestDate: the most recent entry date, used as anchor for relative filters
  // Set by the dashboard when entries load
  const [latestDate, setLatestDate] = useState<string | null>(null);

  const setQuickFilter = useCallback((days: number | 'all') => {
    if (days === 'all') {
      setFilters((prev: FilterState) => ({ ...prev, dateFrom: null, dateTo: null }));
    } else {
      // Use latestDate as anchor if available, otherwise use today
      const anchor = latestDate ? new Date(latestDate + 'T00:00:00Z') : new Date();
      const anchorStr = anchor.toISOString().split('T')[0];

      if (days === 0) {
        // "Today" = latest date
        setFilters((prev: FilterState) => ({ ...prev, dateFrom: anchorStr, dateTo: anchorStr }));
      } else if (days === 1) {
        // "Yesterday" = day before latest
        const prev = new Date(anchor);
        prev.setUTCDate(prev.getUTCDate() - 1);
        const prevStr = prev.toISOString().split('T')[0];
        setFilters((p: FilterState) => ({ ...p, dateFrom: prevStr, dateTo: prevStr }));
      } else {
        const from = new Date(anchor);
        from.setUTCDate(from.getUTCDate() - days);
        setFilters((prev: FilterState) => ({
          ...prev,
          dateFrom: from.toISOString().split('T')[0],
          dateTo: anchorStr,
        }));
      }
    }
  }, [latestDate]);

  const setDateFrom = useCallback((date: string | null) => {
    setFilters((prev: FilterState) => ({ ...prev, dateFrom: date }));
  }, []);

  const setDateTo = useCallback((date: string | null) => {
    setFilters((prev: FilterState) => ({ ...prev, dateTo: date }));
  }, []);

  const setProductId = useCallback((productId: string) => {
    setFilters((prev: FilterState) => ({ ...prev, productId }));
  }, []);

  return { filters, setQuickFilter, setDateFrom, setDateTo, setProductId, setLatestDate };
}
