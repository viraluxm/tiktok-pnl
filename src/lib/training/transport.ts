// Which endpoints a practice host talks to, and with what body.
//
// A host screen now runs in one of two modes:
//   'admin' — an admin is signed in; calls go to /api/admin/training/* and are
//             authorised by the session cookie.
//   'token' — an audition candidate on their own phone with no Lensed account;
//             calls go to /api/host/<token>/* and are authorised solely by the
//             opaque token in the path.
//
// Keeping the difference in ONE pure function, rather than a `mode` check inside
// each hook, means there is a single place to read to know what a tokenised host
// can reach — which matters because that is the security surface.
//
// Deliberately pure and dependency-free so it is unit-testable and safe to import
// from anywhere.

export type PracticeMode = 'admin' | 'token';

export interface PracticeTransport {
  mode: PracticeMode;
  sessionId: string;
  // Present only in 'token' mode.
  token?: string;
}

export interface PracticeEndpoints {
  mode: PracticeMode;
  // POST target for a LiveKit publish grant, plus the body it expects. The admin
  // route takes role+session from the body; the tokenised route takes neither,
  // because both are fixed by the token — which is exactly why a leaked candidate
  // link cannot be pointed at another session.
  livekitToken: { url: string; body: Record<string, unknown> };
  heartbeat: string;
  end: string;
  events: string;
  // The events body differs: the admin route needs session_id, the tokenised route
  // must NOT accept one (it would be an injection point) and takes it from the path.
  eventsBody: (events: unknown[]) => Record<string, unknown>;
  recordingStart: string;
  recordingStop: string;
  // The recording-stop body, for the same reason as events.
  recordingStopBody: Record<string, unknown>;
}

export function practiceEndpoints(t: PracticeTransport): PracticeEndpoints {
  if (t.mode === 'token') {
    if (!t.token) throw new Error('token mode requires a token');
    // encodeURIComponent because a base64url token can contain '-' and '_' (safe)
    // but this must not depend on that remaining true.
    const base = `/api/host/${encodeURIComponent(t.token)}`;
    return {
      mode: 'token',
      livekitToken: { url: `${base}/livekit-token`, body: {} },
      heartbeat: `${base}/heartbeat`,
      end: `${base}/end`,
      events: `${base}/events`,
      eventsBody: (events) => ({ events }),
      recordingStart: `${base}/recording-start`,
      recordingStop: `${base}/recording-stop`,
      recordingStopBody: {},
    };
  }

  return {
    mode: 'admin',
    livekitToken: {
      url: '/api/training/video-token',
      body: { role: 'host', session: t.sessionId },
    },
    heartbeat: `/api/admin/training/sessions/${t.sessionId}/heartbeat`,
    end: `/api/admin/training/sessions/${t.sessionId}/end`,
    events: '/api/admin/training/events',
    eventsBody: (events) => ({ session_id: t.sessionId, events }),
    recordingStart: '/api/admin/training/recording/start',
    recordingStop: '/api/admin/training/recording/stop',
    recordingStopBody: { session_id: t.sessionId },
  };
}
