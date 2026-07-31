/**
 * DRY RUN ONLY — reads tiktok_connections, resolves each shop's numeric shop_id via
 * getAuthorizedShops, and PRINTS the proposed shop_id per connection. Performs NO writes.
 *
 * Run (env comes from the app's own .env files; requires the 074 migration applied so the
 * shop_id column exists to read/compare):
 *   node --env-file=.env.local --env-file=.env --import tsx scripts/backfill-shop-id.dryrun.ts
 *
 * Review the printed proposed_shop_id values, THEN uncomment the APPLY block to write them.
 */
import { createAdminClient } from '@/lib/supabase/admin';
import { getAuthorizedShops } from '@/lib/tiktok/client';
import { decryptOrFallback } from '@/lib/crypto';

async function main() {
  const admin = createAdminClient();
  const { data: conns, error } = await admin
    .from('tiktok_connections')
    .select('id, store_id, shop_name, shop_cipher, shop_id, access_token')
    .order('connected_at', { ascending: true });
  if (error) throw error;

  for (const c of conns ?? []) {
    let proposed: string | null = null;
    let note = '';
    try {
      const token = decryptOrFallback(c.access_token as string, 'access_token');
      const shops = await getAuthorizedShops(token);
      // Match on the shop_cipher already stored, so we tag the right shop even if the token
      // is authorized for more than one shop. Fall back to the sole shop when only one.
      const match =
        shops.find((s) => s.shop_cipher === c.shop_cipher) ??
        (shops.length === 1 ? shops[0] : undefined);
      if (!match) note = `no cipher match (${shops.length} shop(s) returned)`;
      else if (!match.shop_id) note = 'shop matched but shop_id empty';
      else proposed = match.shop_id;
    } catch (e) {
      note = `ERROR ${(e as Error).message}`;
    }

    console.log(JSON.stringify({
      connection_id: c.id,
      store_id: c.store_id,
      shop_name: c.shop_name,
      current_shop_id: c.shop_id,
      proposed_shop_id: proposed,
      note,
    }));

    // APPLY (commented out — review the dry-run output first):
    // if (proposed && proposed !== c.shop_id) {
    //   const { error: upErr } = await admin
    //     .from('tiktok_connections')
    //     .update({ shop_id: proposed })
    //     .eq('id', c.id);
    //   if (upErr) console.error(`update failed for ${c.id}:`, upErr.message);
    // }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
