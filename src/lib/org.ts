import type { SupabaseClient } from '@supabase/supabase-js';

// Resolve a user's org (first membership). Used to org-scope the SHARED tables
// (inventory_skus, sku_batches, products, product_costs) in routes that filter
// explicitly — and by service-role inserts, where auth.uid() is NULL so the
// set_org_id_on_insert trigger can't infer the org. Operations tables stay
// user-scoped and never call this.
export async function getOrgId(client: SupabaseClient, userId: string): Promise<string | null> {
  const { data } = await client
    .from('organization_members')
    .select('org_id')
    .eq('user_id', userId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data?.org_id as string | undefined) ?? null;
}
