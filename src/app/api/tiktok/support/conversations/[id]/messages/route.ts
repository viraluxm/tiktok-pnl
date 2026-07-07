import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import {
  SUPPORT_USE_MOCK,
  getSupportStores,
  getMockConversation,
  getMockMessages,
  buildMockSentMessage,
  csGetConversationMessages,
  csSendMessage,
} from '@/lib/tiktok/support';
import type { MessagesResponse, SendMessageResponse } from '@/lib/tiktok/support-types';

// GET: full message history for one conversation (+ its header context).
// POST: reply to the conversation. Both mock-backed until the CS scope lands;
// the real path (csGetConversationMessages / csSendMessage) is wired below.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const stores = await getSupportStores(auth.user.id);

  if (SUPPORT_USE_MOCK) {
    const conversation = getMockConversation(id, stores);
    if (!conversation) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    const body: MessagesResponse = { conversation, messages: getMockMessages(id), source: 'mock' };
    return NextResponse.json(body);
  }

  // Live path: find the store that owns this conversation, then fetch its thread.
  const convs = (await Promise.all(stores.map(s => csGetConversationMessages(s, id).then(messages => ({ s, messages })).catch(() => null))))
    .find(r => r && r.messages.length > 0);
  if (!convs) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  return NextResponse.json({ messages: convs.messages, source: 'live' });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const supabase = await createClient();
  const { data: auth, error: authError } = await supabase.auth.getUser();
  if (authError || !auth.user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });

  const { text } = await request.json().catch(() => ({ text: '' }));
  const trimmed = String(text || '').trim();
  if (!trimmed) return NextResponse.json({ error: 'Message text is required' }, { status: 400 });

  if (SUPPORT_USE_MOCK) {
    const body: SendMessageResponse = { message: buildMockSentMessage(id, trimmed), source: 'mock' };
    return NextResponse.json(body);
  }

  // Live path: resolve which store owns the conversation, then send.
  const stores = await getSupportStores(auth.user.id);
  const owner = (await Promise.all(stores.map(s => csGetConversationMessages(s, id).then(m => (m.length > 0 ? s : null)).catch(() => null)))).find(Boolean);
  if (!owner) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
  const message = await csSendMessage(owner, id, trimmed);
  return NextResponse.json({ message, source: 'live' } satisfies SendMessageResponse);
}
