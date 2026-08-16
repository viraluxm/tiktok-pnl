import BadgeKiosk from '@/components/kiosk/BadgeKiosk';

export const dynamic = 'force-dynamic';

// The badge time-clock kiosk. Deliberately TOP-LEVEL (not under the (app) route group): the (app)
// layout runs useExtensionAuth, which pushes the session's Supabase JWT to the capture extension —
// on a kiosk machine that would clobber the extension's own capture JWT (see CLAUDE.md). This route
// renders only the kiosk under the confined 'timeclock' session; middleware gates access to it.
export default function KioskPage() {
  return <BadgeKiosk />;
}
