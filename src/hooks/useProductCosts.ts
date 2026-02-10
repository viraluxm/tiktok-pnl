'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { createClient } from '@/lib/supabase/client';
import { useUser } from './useUser';

export interface ProductCost {
  id: string;
  user_id: string;
  product_id: string;
  variant_id: string | null;
  cost_per_unit: number;
  updated_at: string;
}

export function useProductCosts() {
  const { user } = useUser();
  const queryClient = useQueryClient();
  const supabase = createClient();

  const query = useQuery<ProductCost[]>({
    queryKey: ['product_costs', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('product_costs')
        .select('*')
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return data || [];
    },
  });

  const upsertCost = useMutation({
    mutationFn: async ({
      productId,
      variantId,
      costPerUnit,
    }: {
      productId: string;
      variantId: string | null;
      costPerUnit: number;
    }) => {
      const { data, error } = await supabase
        .from('product_costs')
        .upsert(
          {
            user_id: user!.id,
            product_id: productId,
            variant_id: variantId,
            cost_per_unit: costPerUnit,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id,product_id,variant_id' }
        )
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['product_costs'] });
    },
  });

  // Build a lookup map: "productId" or "productId-variantId" -> cost_per_unit
  const costsMap: Record<string, number> = {};
  if (query.data) {
    query.data.forEach((c) => {
      const key = c.variant_id ? `${c.product_id}-${c.variant_id}` : c.product_id;
      costsMap[key] = c.cost_per_unit;
    });
  }

  return {
    costs: query.data || [],
    costsMap,
    isLoading: query.isLoading,
    upsertCost,
  };
}
