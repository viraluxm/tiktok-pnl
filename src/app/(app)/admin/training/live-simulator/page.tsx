import type { Viewport } from 'next';
import LiveSimulator from '@/components/training/LiveSimulator';
import { DEFAULT_SESSION } from '@/components/training/trainerEvents';

// Route-scoped viewport so the full-bleed camera UI can extend into the iPhone
// safe areas (the root layout has no viewport export).
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  viewportFit: 'cover',
  themeColor: '#000000',
};

// ?session= is supported quietly for future use; the trainee never sees it.
// With no param, the host joins the default session — same as the controller.
export default async function LiveSimulatorPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string | string[] }>;
}) {
  const { session } = await searchParams;
  const raw = Array.isArray(session) ? session[0] : session;
  const sessionId = raw?.trim() || DEFAULT_SESSION;
  return <LiveSimulator sessionId={sessionId} />;
}
