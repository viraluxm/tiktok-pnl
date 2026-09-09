import type { Viewport } from 'next';
import { notFound } from 'next/navigation';
import LiveSimulator from '@/components/training/LiveSimulator';
import { resolvePracticeHostToken } from '@/lib/training/hostToken';

// Full-bleed camera UI needs the iPhone safe areas, same as the admin host route.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#000000',
};

// Never cache: the token's validity depends on the session's live state.
export const dynamic = 'force-dynamic';

// PUBLIC practice-host page. NO Supabase auth session is EVER established here.
//
// WHY THIS ROUTE EXISTS. The admin host page sits under (app)/admin and demands
// app_metadata.role === 'admin'. For ~100 auditions a day that would mean handing
// every candidate an admin account, and an admin account on this app reaches P&L,
// orders, inventory and payroll. A candidate needs to read a script into a camera,
// not that.
//
// HOW IT STAYS SAFE:
//   * the token is resolved SERVER-SIDE with the service-role client, and every
//     downstream write is filtered explicitly by the resolved session id — RLS is
//     bypassed by service-role, so the token plus those filters IS the boundary;
//   * middleware excludes /p/ and /api/host/, so updateSession never runs here.
//     That is not cosmetic: establishing a Supabase session on a machine causes the
//     capture extension to relay it and write captures under the wrong user_id,
//     silently (the 2026-07-22 incident). A tokenised route creates no session at
//     all, which is why it is the correct answer rather than a lesser one;
//   * the client is handed mode:'token', so its Realtime client is the session-less
//     one and every API call goes to /api/host/<token>/*;
//   * a bad or ended token is a bare 404 — no hint as to which.
export default async function PracticeHostTokenPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  const resolved = await resolvePracticeHostToken(token);
  // One 404 for unknown AND ended, so the endpoint is not an oracle for which
  // tokens exist.
  if (!resolved) notFound();

  return (
    <LiveSimulator
      sessionId={resolved.sessionId}
      transport={{ mode: 'token', sessionId: resolved.sessionId, token }}
    />
  );
}
