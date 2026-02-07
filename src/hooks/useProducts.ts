'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import type { Product } from '@/types';
import { useUser } from './useUser';

export function useProducts() {
  const { user } = useUser();
  const queryClient = useQueryClient();
  const supabase = createClient();

  const query = useQuery<Product[]>({
    queryKey: ['products', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('products')
        .select('*')
        .order('created_at', { ascending: true });
      if (error) throw error;
      return data || [];
    },
  });

  const addProduct = useMutation({
    mutationFn: async (name: string) => {
      const { data, error } = await supabase
        .from('products')
        .insert({ user_id: user!.id, name })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
    },
  });

  const removeProduct = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('products').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['products'] });
      queryClient.invalidateQueries({ queryKey: ['entries'] });
    },
  });

  return {
    products: query.data || [],
    isLoading: query.isLoading,
    addProduct,
    removeProduct,
  };
}
