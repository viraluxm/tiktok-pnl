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

  // Also fetch products to build tiktok_product_id → UUID mapping
  const productsQuery = useQuery({
    queryKey: ['products-map', user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data } = await supabase.from('products').select('id, tiktok_product_id');
      return data || [];
    },
  });

  const upsertCost = useMutation({
    mutationFn: async ({ productId, variantId, costPerUnit }: { productId: string; variantId: string | null; costPerUnit: number }) => {
      // productId might be a tiktok_product_id — look up the UUID
      let dbProductId = productId;
      const products = productsQuery.data || [];
      const match = products.find((p: { id: string; tiktok_product_id: string | null }) => p.tiktok_product_id === productId);
      if (match) dbProductId = match.id;

      const { data, error } = await supabase
        .from('product_costs')
        .upsert({
          user_id: user!.id,
          product_id: dbProductId,
          variant_id: variantId,
          cost_per_unit: costPerUnit,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,product_id,variant_id' })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['product_costs'] });
    },
  });

  // Build costsMap keyed by BOTH UUID and tiktok_product_id
  const costsMap: Record<string, number> = {};
  const products = productsQuery.data || [];
  const tiktokToUuid = new Map<string, string>();
  for (const p of products) {
    const prod = p as { id: string; tiktok_product_id: string | null };
    if (prod.tiktok_product_id) tiktokToUuid.set(prod.tiktok_product_id, prod.id);
  }

  if (query.data) {
    for (const c of query.data) {
      // Key by UUID
      const uuidKey = c.variant_id ? `${c.product_id}-${c.variant_id}` : c.product_id;
      costsMap[uuidKey] = c.cost_per_unit;

      // Also key by tiktok_product_id for the products page
      for (const [tikId, uuid] of tiktokToUuid.entries()) {
        if (uuid === c.product_id) {
          const tikKey = c.variant_id ? `${tikId}-${c.variant_id}` : tikId;
          costsMap[tikKey] = c.cost_per_unit;
        }
      }
    }
  }

  return {
    costs: query.data || [],
    costsMap,
    isLoading: query.isLoading,
    upsertCost,
  };
}
