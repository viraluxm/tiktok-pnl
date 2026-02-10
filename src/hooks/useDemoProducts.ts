'use client';

import { useState } from 'react';
import { DEMO_PRODUCTS, DEMO_USER_ID } from '@/lib/demo/data';
import type { Product } from '@/types';

/**
 * Drop-in replacement for useProducts() when in demo mode.
 * Returns the same interface but backed by in-memory mock data.
 */
export function useDemoProducts() {
  const [products, setProducts] = useState<Product[]>(() =>
    DEMO_PRODUCTS.map((p) => ({
      id: p.id,
      user_id: p.user_id,
      name: p.name,
      created_at: p.created_at,
    }))
  );

  const addProduct = {
    mutate: (name: string) => {
      const newProduct: Product = {
        id: `demo-product-new-${Date.now()}`,
        user_id: DEMO_USER_ID,
        name,
        created_at: new Date().toISOString(),
      };
      setProducts((prev) => [...prev, newProduct]);
    },
    mutateAsync: async (name: string) => {
      const newProduct: Product = {
        id: `demo-product-new-${Date.now()}`,
        user_id: DEMO_USER_ID,
        name,
        created_at: new Date().toISOString(),
      };
      setProducts((prev) => [...prev, newProduct]);
      return newProduct;
    },
    isPending: false,
  };

  const removeProduct = {
    mutate: (id: string) => {
      setProducts((prev) => prev.filter((p) => p.id !== id));
    },
    isPending: false,
  };

  return {
    products,
    isLoading: false,
    addProduct,
    removeProduct,
  };
}
