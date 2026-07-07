// Shared types for the Customer Support (CSM) inbox — safe to import from both
// client components and server routes (no server-only deps here).
//
// These mirror the shape of the TikTok Shop Customer Service API (v202309):
//   GET  /customer_service/202309/conversations
//   GET  /customer_service/202309/conversations/{conversation_id}/messages
//   POST /customer_service/202309/conversations/{conversation_id}/messages
//   POST /customer_service/202309/conversations/{conversation_id}/messages/read
// so the mock data layer can be swapped for real signed-client calls without
// changing the UI. `store_id` / `store_name` are app-attached (they record which
// connection a conversation came from), not fields returned by TikTok.

export type CSMessageType = 'TEXT' | 'IMAGE' | 'ORDER_CARD' | 'PRODUCT_CARD' | 'SYSTEM';
export type CSSenderRole = 'BUYER' | 'SELLER' | 'SYSTEM';

export interface CSMessage {
  id: string;
  conversation_id: string;
  type: CSMessageType;
  content: string;
  sender_role: CSSenderRole;
  sender_nickname: string;
  create_time: number; // unix seconds
}

export interface CSOrderContext {
  order_id: string;
  product_name: string;
  sku_name: string | null;
  status: string;
}

export interface CSConversation {
  id: string;
  buyer_nickname: string;
  latest_message_content: string;
  latest_message_type: CSMessageType;
  latest_message_time: number; // unix seconds
  latest_message_from_buyer: boolean;
  unread_count: number;
  order: CSOrderContext | null;
  // App-attached — which connection/store this conversation belongs to.
  store_id: string;
  store_name: string;
}

export interface ConversationsResponse {
  conversations: CSConversation[];
  // Whether the data is mock (scope not yet granted) or live CS API data.
  source: 'mock' | 'live';
}

export interface MessagesResponse {
  conversation: CSConversation;
  messages: CSMessage[];
  source: 'mock' | 'live';
}

export interface SendMessageResponse {
  message: CSMessage;
  source: 'mock' | 'live';
}
