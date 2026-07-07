'use client';

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useUser } from './useUser';
import type {
  ConversationsResponse,
  MessagesResponse,
  SendMessageResponse,
  CSMessage,
} from '@/lib/tiktok/support-types';

// Conversation list across stores (server applies the active-store filter).
export function useConversations() {
  const { user } = useUser();
  return useQuery<ConversationsResponse>({
    queryKey: ['support-conversations', user?.id],
    enabled: !!user,
    staleTime: 30_000,
    queryFn: async () => {
      const res = await fetch('/api/tiktok/support/conversations');
      if (!res.ok) throw new Error('Failed to load conversations');
      return res.json();
    },
  });
}

// Full thread for one conversation.
export function useMessages(conversationId: string | null) {
  const { user } = useUser();
  return useQuery<MessagesResponse>({
    queryKey: ['support-messages', user?.id, conversationId],
    enabled: !!user && !!conversationId,
    staleTime: 30_000,
    queryFn: async () => {
      const res = await fetch(`/api/tiktok/support/conversations/${conversationId}/messages`);
      if (!res.ok) throw new Error('Failed to load messages');
      return res.json();
    },
  });
}

// Sends a reply and optimistically appends it to the open thread so the
// composer feels live (mock-backed for now — see support.ts).
export function useSendMessage(conversationId: string | null) {
  const { user } = useUser();
  const qc = useQueryClient();
  const key = ['support-messages', user?.id, conversationId];

  return useMutation<SendMessageResponse, Error, string>({
    mutationFn: async (text: string) => {
      const res = await fetch(`/api/tiktok/support/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error('Failed to send message');
      return res.json();
    },
    onSuccess: (data) => {
      qc.setQueryData<MessagesResponse>(key, (prev) =>
        prev ? { ...prev, messages: [...prev.messages, data.message] } : prev,
      );
    },
  });
}

export type { CSMessage };
