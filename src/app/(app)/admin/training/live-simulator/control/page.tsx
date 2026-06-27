import ControlClient from '@/components/training/ControlClient';
import { DEFAULT_SESSION } from '@/components/training/trainerEvents';

// Trainer controller. Admin-gated via the shared (app)/admin layout.
// Connects to the same default session as the host unless ?session= is provided.
export default async function ControlPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string | string[] }>;
}) {
  const { session } = await searchParams;
  const raw = Array.isArray(session) ? session[0] : session;
  const sessionId = raw?.trim() || DEFAULT_SESSION;
  return <ControlClient sessionId={sessionId} />;
}
