'use client';

import { avatarHue, initialsOf, type DayPerson } from '@/lib/schedule/calendarModel';

// Initials avatar. Employees carry no photo (photo_path is null across the roster), so the
// monogram IS the avatar rather than a fallback — same initials + same deterministic hue as the
// printed badge (src/lib/kiosk/monogram.ts), so a face on the calendar matches the badge in hand.
//
// State is carried by the RING, never by the fill: the fill is the person's identity hue and must
// stay stable, so a ring is the only channel left that can change meaning without changing who it
// looks like. Every ring is also paired with text in the day modal — colour is never the sole cue.

const SIZES = {
  sm: 'w-6 h-6 text-[9px]',
  md: 'w-7 h-7 text-[10px]',
  lg: 'w-9 h-9 text-xs',
} as const;

export type AvatarSize = keyof typeof SIZES;

// Ring per state. 'pending' borrows the same yellow the confirmation banner uses.
function ringFor(state: DayPerson['state']): string {
  switch (state) {
    case 'open': return 'ring-2 ring-tt-cyan';
    case 'pending': return 'ring-2 ring-tt-yellow';
    case 'no_show': return 'ring-2 ring-tt-red/70';
    case 'confirmed': return 'ring-1 ring-white/20';
    default: return 'ring-1 ring-white/10 opacity-70'; // scheduled, not yet worked → recedes
  }
}

export default function PersonAvatar({
  name,
  state,
  size = 'md',
  title,
  onClick,
}: {
  name: string;
  state: DayPerson['state'];
  size?: AvatarSize;
  /**
   * Native browser tooltip. Pass `null` to suppress it — callers that render their own hover card
   * must, or the browser draws its own box on top of theirs a half-second later.
   */
  title?: string | null;
  onClick?: () => void;
}) {
  const hue = avatarHue(name);
  const content = (
    <span
      className={`${SIZES[size]} ${ringFor(state)} inline-flex items-center justify-center rounded-full font-bold text-white select-none shrink-0`}
      style={{ backgroundColor: `hsl(${hue}, 45%, 42%)` }}
      aria-hidden
    >
      {initialsOf(name)}
    </span>
  );

  if (!onClick) return content;
  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); onClick(); }}
      title={title === null ? undefined : (title ?? name)}
      aria-label={name}
      className="rounded-full transition-transform hover:scale-110 hover:z-10 focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan cursor-pointer"
    >
      {content}
    </button>
  );
}
