import { USERNAMES } from './simulatorData';

// Broadcast event name used on the Realtime channel for all trainer<->host messages.
export const TRAINER_EVENT = 'trainer';

// Practice session length. Single source of truth shared by the host (which owns
// the authoritative countdown) and the controller (which derives elapsed time
// from the broadcast secondsLeft). Changing this changes the whole session.
export const SESSION_SECONDS = 30 * 60; // 30-minute practice session

// Final stretch during which both the host and the controller show a clear
// "ending soon" countdown warning.
export const SESSION_ENDING_SECONDS = 10;

// Messages exchanged over the session channel.
//   controller -> host: comment / placeBid / startAuction / resetAuction
//   host -> controller: auctionState (mirror auction state + gate buttons)
//                       sessionState (session clock, viewer count, lifecycle)
export type TrainerEvent =
  | { action: 'comment'; username: string; text: string }
  // amount omitted => host applies the manual +$1 (unchanged). Auto-bidding sends
  // a sanitized integer amount (host clamps to 1–40); $0 = skip, never sent.
  | { action: 'placeBid'; username: string; amount?: number }
  | { action: 'startAuction' }
  | { action: 'resetAuction' }
  | { action: 'auctionState'; running: boolean; bid: number; winner: string | null }
  | { action: 'sessionState'; secondsLeft: number; viewers: number; phase: 'running' | 'complete' };

export function randomUsername(): string {
  return USERNAMES[Math.floor(Math.random() * USERNAMES.length)];
}

// mm:ss formatter for session time. Shared by the host overlay (time remaining)
// and the controller (elapsed time counting up).
export function formatClock(totalSeconds: number): string {
  const safe = Math.max(0, totalSeconds);
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}
