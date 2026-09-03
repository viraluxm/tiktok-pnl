import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const BUCKET = 'inventory-thumbnails';

// GET — everything the Mapping tab needs, in one round trip: the racks, every slot, and the
// active SKU catalogue for assignment. The tab derives aisles, walking order and the
// unmapped list client-side from this (see lib/mapping/route.ts), so there is no server
// state to keep in sync with the grid.
//
// All three reads are RLS-scoped to the caller by the user-scoped client; user_id is also
// filtered explicitly rather than leaning on RLS alone, matching the live pick path.
export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const [racksRes, slotsRes, skusRes] = await Promise.all([
    supabase
      .from('pick_racks')
      .select('id, name, grid_row, grid_col, shelf_count, route_pos_a, route_pos_b, is_active')
      .eq('user_id', user.id)
      .order('grid_row')
      .order('grid_col'),
    supabase
      .from('pick_slots')
      .select('id, rack_id, shelf_index, section_index, side, slot_code, inventory_sku_id, is_active')
      .eq('user_id', user.id)
      .order('shelf_index')
      .order('section_index'),
    supabase
      .from('inventory_skus')
      .select('id, sku_number, title, barcode, thumbnail_path, qty_on_hand')
      .eq('user_id', user.id)
      .eq('is_active', true)
      .order('sku_number'),
  ]);

  const err = racksRes.error || slotsRes.error || skusRes.error;
  if (err) return NextResponse.json({ error: err.message }, { status: 500 });

  const skus = (skusRes.data ?? []).map((s) => {
    const path = (s.thumbnail_path as string | null) ?? null;
    return {
      id: s.id,
      sku_number: s.sku_number,
      title: s.title,
      barcode: s.barcode,
      // Carried so the map can flag a section whose SKU has run out. Can be NEGATIVE — an
      // oversell — which is still "nothing on the shelf" as far as a picker is concerned.
      qty_on_hand: (s.qty_on_hand as number | null) ?? 0,
      thumbnail_url: path ? supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl : null,
    };
  });

  return NextResponse.json({ racks: racksRes.data ?? [], slots: slotsRes.data ?? [], skus });
}
