import type { Metadata } from 'next';
import TimeClockKiosk from '@/components/timeclock/TimeClockKiosk';

// Full-screen employee time-clock kiosk. It lives under (app) so it runs inside the
// account's authenticated session (employees have no logins of their own — the kiosk acts
// as the account and identifies the person by employee_id). The (app) layout renders no
// sidebar/nav, so the kiosk simply fills the viewport; a manager leaves via the in-kiosk
// "Exit Kiosk" control (password-verified).
export const metadata: Metadata = {
  title: 'Time Clock — Lensed',
};

export default function TimeClockPage() {
  return <TimeClockKiosk />;
}
