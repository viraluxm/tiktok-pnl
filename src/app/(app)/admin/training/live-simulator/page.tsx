import type { Viewport } from 'next';
import LiveSimulator from '@/components/training/LiveSimulator';
import InvalidSession from '@/components/training/InvalidSession';
import { isValidTrainingSessionId } from '@/lib/training/session';

// Route-scoped viewport so the full-bleed camera UI can extend into the iPhone
// safe areas (the root layout has no viewport export).
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#000000',
};

// Every practice live is scoped by a required ?session=<uuid> param (created by
// the Practice Mode launcher). Fail closed when it's missing/malformed — never
// silently fall back to a shared room — so two hosts can run concurrently.
export default async function LiveSimulatorPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string | string[] }>;
}) {
  const { session } = await searchParams;
  const sessionId = Array.isArray(session) ? session[0] : session;
  if (!isValidTrainingSessionId(sessionId)) {
    return <InvalidSession />;
  }
  return <LiveSimulator sessionId={sessionId} />;
}
