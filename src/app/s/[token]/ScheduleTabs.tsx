import Link from 'next/link';

// The two views of the employee's ONE permanent link. Plain links, not client state: the page is a
// server component and the week/view live in the URL, so a worker can reload or share-with-self
// without losing their place, and no auth session is ever established (see CLAUDE.md).

export default function ScheduleTabs({
  token, active, availableCount,
}: { token: string; active: 'mine' | 'team'; availableCount: number }) {
  const base = 'flex-1 rounded-md px-3 py-2 text-center text-xs font-semibold transition-colors';
  const on = 'bg-white/10 text-tt-text';
  const off = 'text-tt-muted hover:text-tt-text';
  return (
    <div className="mb-6 flex gap-1 rounded-lg bg-white/5 p-0.5" role="group" aria-label="My schedule or team schedule">
      <Link href={`/s/${token}`} aria-current={active === 'mine' ? 'page' : undefined} className={`${base} ${active === 'mine' ? on : off}`}>
        My Schedule
      </Link>
      <Link href={`/s/${token}?view=team`} aria-current={active === 'team' ? 'page' : undefined} className={`${base} ${active === 'team' ? on : off}`}>
        Team Schedule
        {availableCount > 0 && (
          <span className="ml-1.5 rounded-full bg-tt-cyan/20 px-1.5 py-0.5 text-[10px] font-bold text-tt-cyan">
            {availableCount}
          </span>
        )}
      </Link>
    </div>
  );
}
