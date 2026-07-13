import ControlClient from '@/components/training/ControlClient';
import InvalidSession from '@/components/training/InvalidSession';
import { isValidTrainingSessionId } from '@/lib/training/session';

// Trainer controller. Admin-gated via the shared (app)/admin layout. Requires a
// valid ?session=<uuid> and fails closed otherwise — the controller must join the
// exact same session as its host, never a shared default.
export default async function ControlPage({
  searchParams,
}: {
  searchParams: Promise<{ session?: string | string[] }>;
}) {
  const { session } = await searchParams;
  const sessionId = Array.isArray(session) ? session[0] : session;
  if (!isValidTrainingSessionId(sessionId)) {
    return <InvalidSession />;
  }
  return <ControlClient sessionId={sessionId} />;
}
