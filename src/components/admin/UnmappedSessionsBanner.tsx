'use client';

import Link from 'next/link';
import { useChannelMap } from '@/hooks/useChannelMap';

// Part D flag: a LOUD banner shown on the dashboard when there are sessions with no
// store attribution (store_id IS NULL). It is NOT scoped to the active store filter, so
// an unmapped stream can never hide behind "Snore" / "lots of steals" / "View All".
// Admin-only data source (403 for non-admins → the query errors → banner renders nothing).
export default function UnmappedSessionsBanner() {
  const { data, isError } = useChannelMap();
  if (isError || !data || data.unmapped_total === 0) return null;

  const channels = data.unmapped_by_channel.filter((c) => c.channel_handle).map((c) => c.channel_handle);
  const preview = channels.slice(0, 3).join(', ');
  const more = channels.length > 3 ? ` +${channels.length - 3} more` : '';

  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-tt-red/50 bg-tt-red/10 px-4 py-3">
      <div className="text-sm text-tt-red">
        <span className="font-bold">⚠ {data.unmapped_total} session{data.unmapped_total === 1 ? '' : 's'} not attributed to a store.</span>{' '}
        {preview && <span className="text-tt-red/80">Channels: {preview}{more}.</span>}{' '}
        <span className="text-tt-red/80">Their payouts &amp; P&amp;L won’t reconcile until mapped.</span>
      </div>
      <Link
        href="/admin/channels"
        className="shrink-0 rounded-lg bg-tt-red px-3 py-1.5 text-xs font-semibold text-white hover:opacity-90"
      >
        Map channels →
      </Link>
    </div>
  );
}
