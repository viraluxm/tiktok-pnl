import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { updateInventory } from '@/lib/tiktok/client';
import { decryptOrFallback } from '@/lib/crypto';

export async function POST(request: Request) {
  const supabase = await createClient();
  const { data, error: authError } = await supabase.auth.getUser();
  if (authError || !data.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { productId, skuId, quantity } = await request.json();
  if (!productId || !skuId || quantity === undefined) {
    return NextResponse.json({ error: 'Missing productId, skuId, or quantity' }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: connection } = await admin.from('tiktok_connections').select('access_token, shop_cipher').eq('user_id', data.user.id).single();
  if (!connection?.shop_cipher) return NextResponse.json({ error: 'No TikTok connection' }, { status: 404 });

  const accessToken = decryptOrFallback(connection.access_token, 'access_token');

  const success = await updateInventory(accessToken, connection.shop_cipher, productId, skuId, quantity);
  if (!success) {
    return NextResponse.json({ error: 'Failed to update inventory on TikTok' }, { status: 500 });
  }

  // Also update local variants JSONB
  const { data: product } = await admin.from('products').select('variants').eq('user_id', data.user.id).eq('tiktok_product_id', productId).single();
  if (product?.variants) {
    const variants = (Array.isArray(product.variants) ? product.variants : JSON.parse(product.variants)) as Array<Record<string, unknown>>;
    for (const v of variants) {
      if (v.id === skuId) v.inventory = quantity;
    }
    await admin.from('products').update({ variants }).eq('user_id', data.user.id).eq('tiktok_product_id', productId);
  }

  return NextResponse.json({ success: true, quantity });
}
