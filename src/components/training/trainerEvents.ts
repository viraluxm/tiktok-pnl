import { USERNAMES } from './simulatorData';

// Default channel/session used when no ?session= param is supplied. The trainee
// host screen and the trainer controller both fall back to this, so they connect
// automatically with no setup UI.
export const DEFAULT_SESSION = 'live-simulator-default';

// Broadcast event name used on the Realtime channel for all trainer<->host messages.
export const TRAINER_EVENT = 'trainer';

// Messages exchanged over the session channel.
//   controller -> host: comment / placeBid / startAuction / resetAuction
//   host -> controller: auctionState (so the controller can mirror state + gate buttons)
export type TrainerEvent =
  | { action: 'comment'; username: string; text: string }
  | { action: 'placeBid'; username: string }
  | { action: 'startAuction' }
  | { action: 'resetAuction' }
  | { action: 'auctionState'; running: boolean; bid: number; winner: string | null };

export function randomUsername(): string {
  return USERNAMES[Math.floor(Math.random() * USERNAMES.length)];
}
