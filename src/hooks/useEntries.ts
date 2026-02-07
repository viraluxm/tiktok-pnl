'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import type { Entry, FilterState } from '@/types';
import { useUser } from './useUser';

export function useEntries(filters: FilterState) {
  const { user } = useUser();
  const queryClient = useQueryClient();
  const supabase = createClient();

  const query = useQuery<Entry[]>({
    queryKey: ['entries', user?.id, filters],
    enabled: !!user,
    queryFn: async () => {
      let q = supabase
        .from('entries')
        .select('*, product:products(id, name)')
        .order('date', { ascending: false });

      if (filters.dateFrom) q = q.gte('date', filters.dateFrom);
      if (filters.dateTo) q = q.lte('date', filters.dateTo);
      if (filters.productId !== 'all') q = q.eq('product_id', filters.productId);

      const { data, error } = await q;
      if (error) throw error;
      return data || [];
    },
  });

  const addEntry = useMutation({
    mutationFn: async (entry: {
      product_id: string;
      date: string;
      gmv: number;
      videos_posted: number;
      views: number;
      shipping: number;
      affiliate: number;
      ads: number;
    }) => {
      const { data, error } = await supabase
        .from('entries')
        .insert({ ...entry, user_id: user!.id })
        .select('*, product:products(id, name)')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['entries'] });
    },
  });

  const updateEntry = useMutation({
    mutationFn: async ({ id, ...fields }: { id: string; [key: string]: unknown }) => {
      const { data, error } = await supabase
        .from('entries')
        .update({ ...fields, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select('*, product:products(id, name)')
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['entries'] });
    },
  });

  const deleteEntry = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('entries').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['entries'] });
    },
  });

  const bulkInsert = useMutation({
    mutationFn: async (entries: Array<{
      product_id: string;
      date: string;
      gmv: number;
      videos_posted: number;
      views: number;
      shipping: number;
      affiliate: number;
      ads: number;
    }>) => {
      const withUser = entries.map((e) => ({ ...e, user_id: user!.id }));
      const { data, error } = await supabase
        .from('entries')
        .insert(withUser)
        .select('*, product:products(id, name)');
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['entries'] });
    },
  });

  return {
    entries: query.data || [],
    isLoading: query.isLoading,
    addEntry,
    updateEntry,
    deleteEntry,
    bulkInsert,
  };
}
