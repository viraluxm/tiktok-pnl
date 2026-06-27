// Static data for the internal live-auction practice simulator.
// Comments are intentionally BROAD (not product-specific) because each trainee
// may practice with a different product.

export const HOST_NAME = 'The Auctioneer';

export const COMMENTS: readonly string[] = [
  'how much is shipping?',
  'do you combine shipping?',
  'how do I bid?',
  'can I cancel if I win?',
  'I bid by accident',
  'can I return it?',
  'are all sales final?',
  'what are you running next?',
  "what's your best item?",
  'new here, how does this work?',
  'can you show it closer?',
  'is everything tested?',
  'does it come with accessories?',
  'why is shipping showing twice?',
  'can you run it again?',
  'when does it end?',
  'you skipped my question',
  'is this real?',
  'show it again',
];

export const USERNAMES: readonly string[] = [
  'bargainhunter92',
  'deals4days',
  'shopmom23',
  'techbuyer',
  'auctionfan',
  'firsttimebuyer',
  'westcoastdeals',
  'quickbidder',
  'livebuyer',
  'dealfinder',
];

export interface LiveComment {
  id: number;
  username: string;
  text: string;
}
