import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getActiveStore } from '@/lib/tiktok/activeStore';
import {
  SUPPORT_USE_MOCK,
  getSupportStores,
  getMockConversations,
  csGetConversations,
} from '@/lib/tiktok/support';
import type { ConversationsResponse } from '@/lib/tiktok/support-types';

// Lists Customer Support conversations across the user's stores.
//   "All stores"  -> aggregate every connection's conversations
//   specific store -> filter to that store
// Currently backed by the mock layer (CS scope pending — real calls 105005).
// When SUPPORT_USE_MOCK is false, the same shape comes from csGetConversations().
export async function GET() {
  const supabase = await createClient();
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const activeStore = await getActiveStore();
  const stores = await getSupportStores(auth.user.id);

  let conversations = SUPPORT_USE_MOCK
    ? getMockConversations(stores)
    : (await Promise.all(stores.map(s => csGetConversations(s).catch(() => []))))
        .flat()
        .sort((a, b) => b.latest_message_time - a.latest_message_time);

  if (activeStore !== 'all') {
    conversations = conversations.filter(c => c.store_id === activeStore);
  }

  const body: ConversationsResponse = {
    conversations,
    source: SUPPORT_USE_MOCK ? 'mock' : 'live',
  };
  return NextResponse.json(body);
}
