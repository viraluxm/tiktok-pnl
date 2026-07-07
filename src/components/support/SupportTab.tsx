'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useConversations, useMessages, useSendMessage } from '@/hooks/useSupport';
import type { CSConversation, CSMessage } from '@/lib/tiktok/support-types';

// Two store tag colors, assigned by order of appearance so each shop reads
// consistently across the inbox.
const STORE_COLORS = [
  { dot: 'bg-tt-cyan', text: 'text-tt-cyan', pill: 'bg-tt-cyan/15 text-tt-cyan' },
  { dot: 'bg-tt-magenta-soft', text: 'text-tt-magenta-soft', pill: 'bg-tt-magenta/15 text-tt-magenta-soft' },
  { dot: 'bg-tt-yellow', text: 'text-tt-yellow', pill: 'bg-tt-yellow/15 text-tt-yellow' },
];

const AVATAR_COLORS = [
  'bg-tt-cyan/20 text-tt-cyan',
  'bg-tt-magenta/20 text-tt-magenta-soft',
  'bg-tt-yellow/20 text-tt-yellow',
  'bg-tt-green/20 text-tt-green',
];

function initials(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9]/g, ' ').trim();
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function avatarColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffff;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function relTime(unix: number): string {
  const diff = Math.floor(Date.now() / 1000) - unix;
  if (diff < 60) return 'now';
  const m = Math.floor(diff / 60);
  if (m < 60) return `${m}m`;
  const hr = Math.floor(m / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d`;
  return `${Math.floor(d / 7)}w`;
}

function clockTime(unix: number): string {
  return new Date(unix * 1000).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

export default function SupportTab() {
  const { data, isLoading } = useConversations();
  // The user's explicit pick. The effective selection is derived below so the
  // list defaults to the first conversation and self-heals after a store
  // switch — no setState-in-effect needed.
  const [pickedId, setPickedId] = useState<string | null>(null);

  const conversations = useMemo(() => data?.conversations ?? [], [data]);

  // Stable store→color map by order of appearance.
  const storeColor = useMemo(() => {
    const map = new Map<string, typeof STORE_COLORS[number]>();
    let i = 0;
    for (const c of conversations) {
      if (!map.has(c.store_id)) map.set(c.store_id, STORE_COLORS[i++ % STORE_COLORS.length]);
    }
    return map;
  }, [conversations]);

  // Effective selection: the user's pick if still present, else the first
  // conversation (defaults on load, recovers after a store switch).
  const selectedId =
    pickedId && conversations.some(c => c.id === pickedId) ? pickedId : conversations[0]?.id ?? null;

  const totalUnread = conversations.reduce((sum, c) => sum + c.unread_count, 0);
  const selected = conversations.find(c => c.id === selectedId) ?? null;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16 text-tt-muted">
        <div className="w-5 h-5 border-2 border-tt-muted border-t-transparent rounded-full animate-spin mr-3" />
        Loading conversations...
      </div>
    );
  }

  return (
    <div>
      {/* Section header */}
      <div className="flex items-center justify-between mb-5">
        <div className="flex items-center gap-3">
          <h2 className="text-lg font-bold text-tt-text">Support Inbox</h2>
          {totalUnread > 0 && (
            <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-tt-magenta/15 text-tt-magenta-soft">
              {totalUnread} unread
            </span>
          )}
        </div>
        <span className="text-xs text-tt-muted">{conversations.length} conversations</span>
      </div>

      <div className="flex gap-4 h-[calc(100vh-320px)] min-h-[520px]">
        {/* Conversation list */}
        <div className="w-[340px] flex-shrink-0 bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl overflow-hidden flex flex-col">
          <div className="px-4 py-3 border-b border-tt-border flex-shrink-0">
            <span className="text-[11px] text-tt-muted uppercase tracking-wide font-medium">All conversations</span>
          </div>
          <div className="overflow-y-auto flex-1">
            {conversations.length === 0 ? (
              <div className="px-4 py-12 text-center text-tt-muted text-sm">No conversations yet</div>
            ) : (
              conversations.map(c => (
                <ConversationRow
                  key={c.id}
                  conversation={c}
                  active={c.id === selectedId}
                  color={storeColor.get(c.store_id) ?? STORE_COLORS[0]}
                  onClick={() => setPickedId(c.id)}
                />
              ))
            )}
          </div>
        </div>

        {/* Thread + composer */}
        <div className="flex-1 min-w-0 bg-tt-card border border-tt-border rounded-[14px] backdrop-blur-xl overflow-hidden flex flex-col">
          {selected ? (
            <Thread conversation={selected} color={storeColor.get(selected.store_id) ?? STORE_COLORS[0]} />
          ) : (
            <div className="flex-1 flex flex-col items-center justify-center text-tt-muted gap-3">
              <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="opacity-40">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <p className="text-sm">Select a conversation to view messages</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ConversationRow({
  conversation: c,
  active,
  color,
  onClick,
}: {
  conversation: CSConversation;
  active: boolean;
  color: typeof STORE_COLORS[number];
  onClick: () => void;
}) {
  const unread = c.unread_count > 0;
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-4 py-3 border-b border-[rgba(255,255,255,0.04)] transition-colors flex gap-3 ${
        active ? 'bg-tt-cyan/10' : 'hover:bg-tt-card-hover'
      }`}
    >
      <div className={`w-10 h-10 rounded-full flex-shrink-0 flex items-center justify-center text-[13px] font-semibold ${avatarColor(c.buyer_nickname)}`}>
        {initials(c.buyer_nickname)}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className={`text-[13px] truncate ${unread ? 'font-semibold text-tt-text' : 'font-medium text-tt-text'}`}>
            {c.buyer_nickname}
          </span>
          <span className="text-[10px] text-tt-muted flex-shrink-0">{relTime(c.latest_message_time)}</span>
        </div>
        <div className="flex items-center gap-1.5 mt-0.5">
          <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${color.dot}`} />
          <span className={`text-[10px] truncate ${color.text}`}>{c.store_name}</span>
        </div>
        <div className="flex items-center justify-between gap-2 mt-1">
          <span className={`text-xs truncate ${unread ? 'text-tt-text' : 'text-tt-muted'}`}>
            {c.latest_message_from_buyer ? '' : 'You: '}{c.latest_message_content}
          </span>
          {unread && (
            <span className="flex-shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-tt-magenta text-white text-[10px] font-bold flex items-center justify-center">
              {c.unread_count}
            </span>
          )}
        </div>
      </div>
    </button>
  );
}

function Thread({
  conversation: c,
  color,
}: {
  conversation: CSConversation;
  color: typeof STORE_COLORS[number];
}) {
  const { data, isLoading } = useMessages(c.id);
  const send = useSendMessage(c.id);
  const [draft, setDraft] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const messages = data?.messages ?? [];

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  function handleSend() {
    const text = draft.trim();
    if (!text || send.isPending) return;
    setDraft('');
    send.mutate(text);
  }

  return (
    <>
      {/* Thread header */}
      <div className="px-5 py-4 border-b border-tt-border flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className={`w-9 h-9 rounded-full flex-shrink-0 flex items-center justify-center text-xs font-semibold ${avatarColor(c.buyer_nickname)}`}>
            {initials(c.buyer_nickname)}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-tt-text truncate">@{c.buyer_nickname}</span>
              <span className={`text-[10px] font-medium px-2 py-0.5 rounded-full ${color.pill}`}>{c.store_name}</span>
            </div>
            {c.order ? (
              <span className="text-[11px] text-tt-muted">
                Order #{c.order.order_id.slice(-10)} · {c.order.product_name}
                {c.order.sku_name ? ` (${c.order.sku_name})` : ''}
              </span>
            ) : (
              <span className="text-[11px] text-tt-muted">Pre-purchase question</span>
            )}
          </div>
        </div>
        {c.order && <OrderStatusBadge status={c.order.status} />}
      </div>

      {/* Messages */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-5 flex flex-col gap-3">
        {isLoading ? (
          <div className="flex items-center justify-center py-8 text-tt-muted text-sm">
            <div className="w-4 h-4 border-2 border-tt-muted border-t-transparent rounded-full animate-spin mr-2" />
            Loading messages...
          </div>
        ) : (
          messages.map(m => <MessageBubble key={m.id} message={m} />)
        )}
      </div>

      {/* Composer */}
      <div className="px-4 py-3 border-t border-tt-border flex-shrink-0">
        <div className="flex items-end gap-2 bg-tt-input-bg border border-tt-input-border rounded-2xl px-3 py-2 focus-within:border-tt-cyan/40 transition-colors">
          <textarea
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleSend();
              }
            }}
            rows={1}
            placeholder="Type a reply…"
            className="flex-1 bg-transparent resize-none text-sm text-tt-text placeholder:text-tt-muted/60 focus:outline-none max-h-28 py-1.5"
          />
          <button
            onClick={handleSend}
            disabled={!draft.trim() || send.isPending}
            className="flex-shrink-0 w-9 h-9 rounded-full bg-tt-cyan text-black flex items-center justify-center hover:bg-tt-cyan/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            aria-label="Send reply"
          >
            {send.isPending ? (
              <span className="w-4 h-4 border-2 border-black/30 border-t-black rounded-full animate-spin" />
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 2L11 13M22 2l-7 20-4-9-9-4 20-7z" />
              </svg>
            )}
          </button>
        </div>
      </div>
    </>
  );
}

function MessageBubble({ message: m }: { message: CSMessage }) {
  const fromSeller = m.sender_role === 'SELLER';
  return (
    <div className={`flex ${fromSeller ? 'justify-end' : 'justify-start'}`}>
      <div className={`max-w-[72%] flex flex-col ${fromSeller ? 'items-end' : 'items-start'}`}>
        <div
          className={`px-3.5 py-2.5 rounded-2xl text-sm leading-relaxed ${
            fromSeller
              ? 'bg-tt-cyan text-black rounded-br-md'
              : 'bg-white/[0.06] text-tt-text rounded-bl-md'
          }`}
        >
          {m.content}
        </div>
        <span className="text-[10px] text-tt-muted mt-1 px-1">{clockTime(m.create_time)}</span>
      </div>
    </div>
  );
}

function OrderStatusBadge({ status }: { status: string }) {
  const s = status.toLowerCase();
  let cls = 'bg-tt-muted/15 text-tt-muted';
  if (s.includes('deliver')) cls = 'bg-tt-green/15 text-tt-green';
  else if (s.includes('ship')) cls = 'bg-tt-cyan/15 text-tt-cyan';
  else if (s.includes('process')) cls = 'bg-tt-yellow/15 text-tt-yellow';
  else if (s.includes('return') || s.includes('cancel')) cls = 'bg-tt-magenta/15 text-tt-magenta-soft';
  return (
    <span className={`flex-shrink-0 text-[10px] font-semibold px-2.5 py-1 rounded-md ${cls}`}>{status}</span>
  );
}
