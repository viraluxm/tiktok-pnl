'use client';

import { useState } from 'react';
import type { Product } from '@/types';

interface ProductManagerProps {
  products: Product[];
  onAddProduct: (name: string) => void;
  onRemoveProduct: (id: string) => void;
}

export default function ProductManager({ products, onAddProduct, onRemoveProduct }: ProductManagerProps) {
  const [name, setName] = useState('');

  function handleAdd() {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (products.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())) {
      setName('');
      return;
    }
    onAddProduct(trimmed);
    setName('');
  }

  return (
    <div className="bg-tt-card border border-tt-border rounded-[14px] p-5 backdrop-blur-xl">
      <h3 className="text-sm font-semibold mb-3">Manage Products</h3>
      <div className="flex flex-wrap gap-2 mb-3">
        {products.map((p) => (
          <span
            key={p.id}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-[rgba(105,201,208,0.1)] border border-[rgba(105,201,208,0.25)] text-[13px] text-tt-cyan"
          >
            {p.name}
            <button
              onClick={() => onRemoveProduct(p.id)}
              disabled={products.length <= 1}
              className="text-tt-muted hover:text-tt-red text-sm leading-none p-0 bg-none border-none cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            >
              &times;
            </button>
          </span>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && handleAdd()}
          placeholder="Enter product name..."
          className="flex-1 bg-tt-input-bg border border-tt-input-border text-tt-text px-3 py-2 rounded-lg text-[13px] focus:outline-none focus:border-tt-cyan transition-colors"
        />
        <button
          onClick={handleAdd}
          className="px-4 py-2 rounded-lg bg-gradient-to-r from-tt-cyan to-[#4db8c0] text-black text-[13px] font-semibold hover:opacity-90 transition-opacity"
        >
          Add Product
        </button>
      </div>
    </div>
  );
}
