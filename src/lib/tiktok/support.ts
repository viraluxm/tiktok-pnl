// Server-only Customer Support (CSM) data layer.
//
// Two paths live here:
//  1. REAL CS API calls (csGetConversations / csGetConversationMessages /
//     csSendMessage / csMarkRead) — signed via the existing shopGet/shopPost
//     client. These are wired and ready but currently return TikTok error 105005
//     ("access scope not granted") until the Customer Service scope is approved
//     on the app and each shop re-authorizes.
//  2. A MOCK layer with the exact same return shapes, used while the scope is
//     pending so we can build + demo the inbox.
//
// SUPPORT_USE_MOCK flips between them. When the scope lands, set it to false
// (or drive it from an env flag) and the API routes call the real functions —
// no UI changes required.

import { shopGet, shopPost } from './client';
import { createAdminClient } from '@/lib/supabase/admin';
import { decryptOrFallback } from '@/lib/crypto';
import type {
  CSConversation,
  CSMessage,
  CSMessageType,
  CSSenderRole,
} from './support-types';

export const SUPPORT_USE_MOCK = true;

const CS_BASE = '/customer_service/202309';

// A store the inbox aggregates over (one per connection).
export interface SupportStore {
  store_id: string;
  store_name: string;
  shop_cipher: string;
  access_token: string; // decrypted
}

// ==================== REAL CS API (ready; 105005 until scope granted) ====================

// Maps a raw TikTok conversation object to our view shape, tagging it with the
// store it came from. Field names follow the v202309 Customer Service schema.
function mapConversation(raw: Record<string, unknown>, store: SupportStore): CSConversation {
  const participants = (raw.participants || []) as Array<Record<string, unknown>>;
  const buyer = participants.find(p => String(p.role).toUpperCase() === 'BUYER');
  const latest = (raw.latest_message || {}) as Record<string, unknown>;
  const latestSender = String(latest.sender_role || (latest.sender as Record<string, unknown>)?.role || '').toUpperCase();
  return {
    id: String(raw.id || raw.conversation_id || ''),
    buyer_nickname: String(buyer?.nickname || raw.buyer_nickname || 'Buyer'),
    latest_message_content: extractText(latest),
    latest_message_type: (String(latest.type || 'TEXT').toUpperCase() as CSMessageType),
    latest_message_time: Number(latest.create_time || raw.latest_message_create_time || 0),
    latest_message_from_buyer: latestSender === 'BUYER',
    unread_count: Number(raw.unread_count || 0),
    order: null,
    store_id: store.store_id,
    store_name: store.store_name,
  };
}

function mapMessage(raw: Record<string, unknown>, conversationId: string): CSMessage {
  const sender = (raw.sender || {}) as Record<string, unknown>;
  return {
    id: String(raw.id || raw.message_id || ''),
    conversation_id: conversationId,
    type: (String(raw.type || 'TEXT').toUpperCase() as CSMessageType),
    content: extractText(raw),
    sender_role: (String(raw.sender_role || sender.role || 'BUYER').toUpperCase() as CSSenderRole),
    sender_nickname: String(sender.nickname || ''),
    create_time: Number(raw.create_time || 0),
  };
}

// TikTok text messages carry content as a JSON string like {"content":"hi"}.
function extractText(raw: Record<string, unknown>): string {
  const c = raw.content;
  if (typeof c === 'string') {
    try {
      const parsed = JSON.parse(c);
      if (parsed && typeof parsed.content === 'string') return parsed.content;
    } catch {
      // not JSON — use as-is
    }
    return c;
  }
  return '';
}

export async function csGetConversations(store: SupportStore): Promise<CSConversation[]> {
  const data = await shopGet(`${CS_BASE}/conversations`, store.access_token, {
    shop_cipher: store.shop_cipher,
    page_size: '50',
  });
  const list = (data?.conversations || []) as Array<Record<string, unknown>>;
  return list.map(c => mapConversation(c, store));
}

export async function csGetConversationMessages(
  store: SupportStore,
  conversationId: string,
): Promise<CSMessage[]> {
  const data = await shopGet(`${CS_BASE}/conversations/${conversationId}/messages`, store.access_token, {
    shop_cipher: store.shop_cipher,
    page_size: '50',
  });
  const list = (data?.messages || []) as Array<Record<string, unknown>>;
  return list.map(m => mapMessage(m, conversationId));
}

export async function csSendMessage(
  store: SupportStore,
  conversationId: string,
  text: string,
): Promise<CSMessage> {
  const data = await shopPost(
    `${CS_BASE}/conversations/${conversationId}/messages`,
    store.access_token,
    { type: 'TEXT', content: JSON.stringify({ content: text }) },
    { shop_cipher: store.shop_cipher },
  );
  return mapMessage((data || {}) as Record<string, unknown>, conversationId);
}

export async function csMarkRead(store: SupportStore, conversationId: string): Promise<void> {
  await shopPost(
    `${CS_BASE}/conversations/${conversationId}/messages/read`,
    store.access_token,
    {},
    { shop_cipher: store.shop_cipher },
  );
}

// ==================== MOCK LAYER (same shapes) ====================

interface MockMessage {
  role: CSSenderRole;
  content: string;
  minutesAgo: number;
}

interface MockConversation {
  id: string;
  storeSlot: 0 | 1;
  buyer_nickname: string;
  unread_count: number;
  order: { order_id: string; product_name: string; sku_name: string | null; status: string } | null;
  messages: MockMessage[];
}

// Realistic support threads across two stores. storeSlot maps to the Nth
// connected store so "All stores" aggregation shows a genuine mix.
const MOCK_CONVERSATIONS: MockConversation[] = [
  {
    id: '7382910011234500001',
    storeSlot: 0,
    buyer_nickname: 'jayda.styles',
    unread_count: 2,
    order: { order_id: '5772014983261099', product_name: 'Oversized Cropped Hoodie', sku_name: 'Sand / M', status: 'Shipped' },
    messages: [
      { role: 'BUYER', content: 'hi! i ordered the hoodie last week, do you have a tracking number yet?', minutesAgo: 41 },
      { role: 'SELLER', content: 'Hey Jayda! Yes — it shipped Tuesday, tracking is 9400 1000 0000 1234 5678. Should land in 2–3 days 📦', minutesAgo: 33 },
      { role: 'BUYER', content: 'perfect thank you!! also is the sand color true to the photos?', minutesAgo: 7 },
      { role: 'BUYER', content: 'like is it more beige or grey', minutesAgo: 6 },
    ],
  },
  {
    id: '7382910011234500002',
    storeSlot: 1,
    buyer_nickname: 'marcus_h',
    unread_count: 1,
    order: { order_id: '5772014983261145', product_name: 'Everyday Canvas Tote', sku_name: 'Black', status: 'Delivered' },
    messages: [
      { role: 'BUYER', content: 'the tote showed as delivered but i never got it. porch was empty all day', minutesAgo: 128 },
      { role: 'SELLER', content: 'So sorry about that Marcus. Let me open a case with the carrier and get a replacement out to you today — no charge.', minutesAgo: 119 },
      { role: 'BUYER', content: 'appreciate it 🙏', minutesAgo: 96 },
      { role: 'BUYER', content: 'quick q — will the replacement need a signature this time?', minutesAgo: 52 },
    ],
  },
  {
    id: '7382910011234500003',
    storeSlot: 0,
    buyer_nickname: 'thelittlethings.co',
    unread_count: 0,
    order: { order_id: '5772014983260871', product_name: 'Ribbed Seamless Set', sku_name: 'Sage / S', status: 'Return requested' },
    messages: [
      { role: 'BUYER', content: 'the top fits great but the leggings are a little snug, can i exchange for a medium?', minutesAgo: 320 },
      { role: 'SELLER', content: 'Absolutely! I’ve started an exchange for the M leggings. You’ll get a prepaid return label by email in a few minutes.', minutesAgo: 300 },
      { role: 'BUYER', content: 'got it, thanks so much — love the set otherwise!', minutesAgo: 288 },
      { role: 'SELLER', content: 'Yay! Enjoy 💛', minutesAgo: 286 },
    ],
  },
  {
    id: '7382910011234500004',
    storeSlot: 1,
    buyer_nickname: 'coen.wright',
    unread_count: 3,
    order: { order_id: '5772014983261302', product_name: 'Weighted Knit Blanket', sku_name: '15 lb / Charcoal', status: 'Processing' },
    messages: [
      { role: 'BUYER', content: 'hey i think i ordered the wrong weight, i meant to get the 20lb not the 15', minutesAgo: 18 },
      { role: 'BUYER', content: 'has it shipped yet? can i still change it?', minutesAgo: 17 },
      { role: 'BUYER', content: 'hello?', minutesAgo: 3 },
    ],
  },
  {
    id: '7382910011234500005',
    storeSlot: 0,
    buyer_nickname: 'sunny.daze22',
    unread_count: 0,
    order: { order_id: '5772014983260544', product_name: 'Linen Wide-Leg Pants', sku_name: 'Ivory / L', status: 'Delivered' },
    messages: [
      { role: 'BUYER', content: 'these pants are gorgeous 😍 do you restock the ivory in XL? my sister wants a pair', minutesAgo: 610 },
      { role: 'SELLER', content: 'So glad you love them! Ivory XL is back in stock next Monday — I’ll drop the link here when it’s live.', minutesAgo: 600 },
      { role: 'BUYER', content: 'you’re the best, thank you!', minutesAgo: 590 },
    ],
  },
  {
    id: '7382910011234500006',
    storeSlot: 1,
    buyer_nickname: 'dtripp',
    unread_count: 1,
    order: { order_id: '5772014983261410', product_name: 'Stainless Insulated Bottle', sku_name: '32 oz / Ocean', status: 'Delivered' },
    messages: [
      { role: 'BUYER', content: 'bottle arrived with a dent on the bottom and the lid leaks a bit', minutesAgo: 240 },
      { role: 'SELLER', content: 'That’s not the experience we want — I can send a replacement or refund you fully, whichever you prefer.', minutesAgo: 230 },
      { role: 'BUYER', content: 'replacement please! same color if possible', minutesAgo: 205 },
    ],
  },
  {
    id: '7382910011234500007',
    storeSlot: 0,
    buyer_nickname: 'kayleighb',
    unread_count: 0,
    order: null,
    messages: [
      { role: 'BUYER', content: 'do you offer bundle discounts if i buy 3 of the crop tanks?', minutesAgo: 1450 },
      { role: 'SELLER', content: 'We do! Use code BUNDLE15 for 15% off when you add 3+ tanks to your cart 🛒', minutesAgo: 1440 },
      { role: 'BUYER', content: 'amazing, just ordered. thanks!', minutesAgo: 1400 },
      { role: 'SELLER', content: 'Got it — packing it up now. Thank you! 🙌', minutesAgo: 1390 },
    ],
  },
];

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function toMessages(mc: MockConversation): CSMessage[] {
  const now = nowSeconds();
  return mc.messages.map((m, i) => ({
    id: `${mc.id}-m${i + 1}`,
    conversation_id: mc.id,
    type: 'TEXT' as CSMessageType,
    content: m.content,
    sender_role: m.role,
    sender_nickname: m.role === 'BUYER' ? mc.buyer_nickname : 'You',
    create_time: now - m.minutesAgo * 60,
  }));
}

function toConversation(mc: MockConversation, store: SupportStore): CSConversation {
  const msgs = toMessages(mc);
  const last = msgs[msgs.length - 1];
  return {
    id: mc.id,
    buyer_nickname: mc.buyer_nickname,
    latest_message_content: last.content,
    latest_message_type: last.type,
    latest_message_time: last.create_time,
    latest_message_from_buyer: last.sender_role === 'BUYER',
    unread_count: mc.unread_count,
    order: mc.order,
    store_id: store.store_id,
    store_name: store.store_name,
  };
}

// Resolves the store for a mock conversation's slot, wrapping if fewer stores
// are connected than slots referenced.
function storeForSlot(slot: number, stores: SupportStore[]): SupportStore | null {
  if (stores.length === 0) return null;
  return stores[slot % stores.length];
}

export function getMockConversations(stores: SupportStore[]): CSConversation[] {
  return MOCK_CONVERSATIONS
    .map(mc => {
      const store = storeForSlot(mc.storeSlot, stores);
      return store ? toConversation(mc, store) : null;
    })
    .filter((c): c is CSConversation => c !== null)
    .sort((a, b) => b.latest_message_time - a.latest_message_time);
}

export function getMockConversation(conversationId: string, stores: SupportStore[]): CSConversation | null {
  const mc = MOCK_CONVERSATIONS.find(c => c.id === conversationId);
  if (!mc) return null;
  const store = storeForSlot(mc.storeSlot, stores);
  return store ? toConversation(mc, store) : null;
}

export function getMockMessages(conversationId: string): CSMessage[] {
  const mc = MOCK_CONVERSATIONS.find(c => c.id === conversationId);
  return mc ? toMessages(mc) : [];
}

// Placeholder stores so the inbox still demos when no shop is connected
// (mock mode only). Slots 0/1 map to these two.
const PLACEHOLDER_STORES: SupportStore[] = [
  { store_id: 'demo-store-a', store_name: 'Store A', shop_cipher: '', access_token: '' },
  { store_id: 'demo-store-b', store_name: 'Store B', shop_cipher: '', access_token: '' },
];

// Loads ALL of the user's connected stores (ordered stably by store_id) so mock
// conversation slots map to consistent stores. Callers filter by the active
// store afterward — matching how "All stores" aggregates vs. a single-store view.
export async function getSupportStores(userId: string): Promise<SupportStore[]> {
  const admin = createAdminClient();
  const { data } = await admin
    .from('tiktok_connections')
    .select('store_id, shop_name, shop_cipher, access_token')
    .eq('user_id', userId)
    .order('store_id', { ascending: true });

  const stores: SupportStore[] = (data || [])
    .filter(c => c.store_id && c.shop_cipher && c.access_token)
    .map((c, i) => ({
      store_id: String(c.store_id),
      store_name: String(c.shop_name || `Store ${i + 1}`),
      shop_cipher: String(c.shop_cipher),
      access_token: decryptOrFallback(String(c.access_token), 'access_token'),
    }));

  if (stores.length === 0 && SUPPORT_USE_MOCK) return PLACEHOLDER_STORES;
  return stores;
}

// Builds a mock "sent" seller message so the composer feels live.
export function buildMockSentMessage(conversationId: string, text: string): CSMessage {
  return {
    id: `${conversationId}-sent-${nowSeconds()}`,
    conversation_id: conversationId,
    type: 'TEXT',
    content: text,
    sender_role: 'SELLER',
    sender_nickname: 'You',
    create_time: nowSeconds(),
  };
}
