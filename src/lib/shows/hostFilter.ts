// Per-host narrowing for one show.
//
// The whole point of this module is that there is exactly ONE place where "which sales belong
// to this host" is decided on the client, and it is a pure function over rows the SERVER
// already tagged (pnl_show_auction_hosts, migration 158). The client never re-derives the
// assignment from timestamps: the board's `logged_at` is the close/flip instant, which
// diverges from the sale anchor by more than five minutes on 7.3% of rows, so deciding here
// would misfile roughly one row in fourteen across a host switch — which is exactly the kind
// of error a host bonus would then be paid on.

// Chip id for sales that matched no host segment. Real host ids are uuids, so no collision.
export const UNATTRIBUTED_HOST = 'unattributed';

export interface HostTaggedItem {
  host_id?: string | null;
  host_unattributed?: boolean;
}

export interface HostRollupLike {
  host_id: string | null;
  host_name: string;
  minutes: number;
  auctions: number;
}

/**
 * Narrow a show's rows to one host. `null` means "All hosts" and returns the array unchanged.
 *
 * An unbound row (captured but never bound) carries no host and is only ever shown under
 * "All hosts": it has no units and no cost, belongs to the bind workflow, and guessing an
 * owner for it would put someone else's sale in a host's numbers.
 */
export function filterItemsByHost<T extends HostTaggedItem>(items: readonly T[], hostFilter: string | null): T[] {
  if (!hostFilter) return [...items];
  if (hostFilter === UNATTRIBUTED_HOST) return items.filter((it) => it.host_unattributed === true);
  return items.filter((it) => it.host_id === hostFilter);
}

/** Stable chip id for a rollup: the host's id, or the unattributed bucket. */
export function hostKey(h: Pick<HostRollupLike, 'host_id'>): string {
  return h.host_id ?? UNATTRIBUTED_HOST;
}

/**
 * The host a show should be LABELLED with: the one with the most air time.
 *
 * Deliberately NOT live_sessions.host_id, which the extension overwrites on every switch and
 * therefore names whoever hosted LAST — so a host covering the final twenty minutes would own
 * the whole row. Longest-on-air is the one that answers "whose show was this?".
 *
 * Unattributed time never wins the label: it is a gap in the segment log, not a person.
 */
export function leadHost<T extends HostRollupLike>(rollups: readonly T[]): T | null {
  let best: T | null = null;
  for (const h of rollups) {
    if (h.host_id == null) continue;
    if (!best || h.minutes > best.minutes) best = h;
  }
  return best;
}

/**
 * How many OTHER real hosts a show had, for the "+N" badge next to the lead.
 * Unattributed is excluded — the badge counts people, not gaps.
 */
export function otherHostCount(rollups: readonly HostRollupLike[]): number {
  const real = rollups.filter((h) => h.host_id != null).length;
  return real > 1 ? real - 1 : 0;
}

/**
 * Air time in ms for the selected host, or null for "All hosts" (the caller then uses the
 * show's own duration).
 *
 * Every RATE in a filtered view divides by this, never by the show's duration: one host's
 * units over the whole show's hours would understate them by however long they were off-mic.
 */
export function hostAirTimeMs(selected: Pick<HostRollupLike, 'minutes'> | null): number | null {
  if (!selected) return null;
  return selected.minutes * 60_000;
}
