// Static landing for a confined 'member' who holds NO recognized scope (empty or unknown
// app_metadata.scopes). Middleware sends them here as their role home, and — because a role's home
// is always reachable even with an empty allowlist — this page renders without looping back to
// /login. It is deliberately inert: a server component with NO data reads, NO API calls, and NO
// member nav (which would fetch the session). Grant the member a scope from the admin Team page to
// give them an area.
export default function MemberNoAccessPage() {
  return (
    <main className="min-h-screen bg-tt-bg text-tt-text p-6 flex items-center justify-center">
      <div className="max-w-md rounded-2xl border border-tt-border bg-tt-card px-6 py-8 text-center">
        <h1 className="text-xl font-bold">No areas assigned</h1>
        <p className="mt-2 text-sm text-tt-muted">
          Your account doesn&apos;t have any areas enabled yet. Please contact an administrator to
          get access.
        </p>
      </div>
    </main>
  );
}
