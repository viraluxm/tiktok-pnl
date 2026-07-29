'use client';

import { useEffect, useState } from 'react';

// Business timezone — the same 'America/Los_Angeles' the finance/PnL code uses, and the
// default the clock-out RPC derives shift wall-clock times through. Displaying the kiosk
// clock in this zone keeps the on-screen time consistent with what actually gets recorded,
// regardless of where the iPad's OS clock is set. (Informational only — never stored.)
const SHOP_TIMEZONE = 'America/Los_Angeles';

const timeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: SHOP_TIMEZONE,
  hour: 'numeric',
  minute: '2-digit',
  hour12: true,
});
const secondsFmt = new Intl.DateTimeFormat('en-US', { timeZone: SHOP_TIMEZONE, second: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: SHOP_TIMEZONE,
  weekday: 'long',
  month: 'long',
  day: 'numeric',
});

// A live-updating wall clock. Renders nothing until mounted so the client render (which
// knows "now") never disagrees with the server render.
export default function LiveClock({
  size = 'lg',
  showDate = true,
  showSeconds = true,
}: {
  size?: 'lg' | 'sm';
  showDate?: boolean;
  showSeconds?: boolean;
}) {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    // First paint is deferred into a timer (not a synchronous setState in the effect body)
    // so the client render matches the server's "not yet mounted" render — no hydration
    // mismatch on the seconds — then it ticks every second.
    const update = () => setNow(new Date());
    const first = setTimeout(update, 0);
    const id = setInterval(update, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(id);
    };
  }, []);

  const timeClass = size === 'lg' ? 'text-6xl sm:text-7xl' : 'text-3xl';
  const dateClass = size === 'lg' ? 'text-lg sm:text-xl' : 'text-sm';

  return (
    <div className="text-center tabular-nums select-none" aria-live="off">
      <div className={`${timeClass} font-semibold text-tt-text tracking-tight`}>
        {now ? (
          <>
            {timeFmt.format(now)}
            {showSeconds && (
              <span className="text-tt-muted text-[0.45em] align-top ml-1">
                {secondsFmt.format(now)}
              </span>
            )}
          </>
        ) : (
          <span className="opacity-0">00:00</span>
        )}
      </div>
      {showDate && (
        <div className={`${dateClass} text-tt-muted mt-1`}>{now ? dateFmt.format(now) : ' '}</div>
      )}
    </div>
  );
}
