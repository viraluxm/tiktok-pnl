'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import type { User, Provider } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/client';
import { exitFullscreen } from '@/lib/fullscreen';

// Land the manager back on Team → Shifts after exiting (one-shot; read by RealDashboard +
// EmployeesTab on mount). sessionStorage survives the client nav and the OAuth round-trip.
function markReturnToShifts() {
  try {
    sessionStorage.setItem('lensed.dashboardTab', 'employees');
    sessionStorage.setItem('lensed.employeesSubView', 'shifts');
  } catch {
    /* ignore */
  }
}

// The "Exit Kiosk" control. Hiding a button is NOT a security boundary — an employee could
// still find it — so leaving the kiosk requires RE-VERIFYING the owner's identity. Lensed
// supports two sign-up methods, so we adapt to whichever the account uses:
//   • password accounts → re-enter the account password (signInWithPassword), mirroring the
//     re-verify pattern in account/page.tsx.
//   • OAuth-only accounts (e.g. Google, no password) → re-verify through the provider
//     (signInWithOAuth), mirroring the login page; on return the callback lands on /dashboard.
// Either way an employee without the owner's credential cannot leave.
//
// LIMITATION: this is app-level protection only. On a shared iPad already signed into the
// owner's Google, the OAuth re-verify may complete silently. The real device lock is Apple
// Guided Access — see the report. We never fall back to an unprotected Exit button.
export default function ExitKioskButton({ user }: { user: User | null }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const email = user?.email ?? null;
  const identities = user?.identities ?? [];
  // A password login exists iff there is an 'email' identity; otherwise the owner signed up
  // with an OAuth provider and has no password to re-enter.
  const hasPassword = identities.some((i) => i.provider === 'email');
  const oauthProvider = (identities.find((i) => i.provider !== 'email')?.provider ?? null) as Provider | null;
  // Prefer password re-verify; fall back to OAuth for OAuth-only owners; last resort (no
  // identity info but we do have an email) still attempts password rather than opening up.
  const mode: 'password' | 'oauth' | 'unknown' = hasPassword
    ? 'password'
    : oauthProvider
      ? 'oauth'
      : email
        ? 'password'
        : 'unknown';
  const providerLabel = oauthProvider
    ? oauthProvider.charAt(0).toUpperCase() + oauthProvider.slice(1)
    : 'your provider';

  const close = () => {
    if (busy) return;
    setOpen(false);
    setPassword('');
    setError(null);
  };

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    if (!email) {
      setError('No signed-in account to verify against.');
      return;
    }
    setBusy(true);
    setError(null);
    const supabase = createClient();
    const { error: authError } = await supabase.auth.signInWithPassword({ email, password });
    if (authError) {
      setError('Incorrect password.');
      setBusy(false);
      return;
    }
    markReturnToShifts();
    exitFullscreen(); // drop out of browser fullscreen before returning to the dashboard shell
    router.push('/dashboard');
  };

  const verifyWithOAuth = async () => {
    if (busy || !oauthProvider) return;
    setBusy(true);
    setError(null);
    markReturnToShifts();
    exitFullscreen(); // leave fullscreen before the provider redirect / dashboard return
    const supabase = createClient();
    // Re-verify through the provider; the app's callback exchanges the code and forwards to
    // `next` (/dashboard) — so a successful re-verify IS the exit. Mirrors the login flow.
    const { error: oauthError } = await supabase.auth.signInWithOAuth({
      provider: oauthProvider,
      options: { redirectTo: `${window.location.origin}/auth/callback?next=/dashboard` },
    });
    if (oauthError) {
      setError(oauthError.message);
      setBusy(false);
    }
    // On success the browser navigates away to the provider; nothing more to do here.
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-tt-muted/70 hover:text-tt-text border border-tt-border rounded-lg px-3 py-2 transition-colors"
      >
        Exit Kiosk
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true">
          <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={close} />
          <div className="relative bg-tt-card border border-tt-border rounded-2xl p-6 w-full max-w-sm shadow-2xl">
            <h2 className="text-base font-semibold text-tt-text">Exit kiosk mode</h2>

            {mode === 'password' ? (
              <form onSubmit={submitPassword}>
                <p className="text-xs text-tt-muted mt-1">
                  Enter the account password to leave the time clock and return to the dashboard.
                </p>
                <input
                  type="password"
                  autoFocus
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Account password"
                  className="mt-4 w-full rounded-lg bg-tt-input-bg border border-tt-input-border px-3 py-2.5 text-sm text-tt-text outline-none focus:border-tt-cyan/60"
                />
                {error && <p className="mt-2 text-xs text-tt-red">{error}</p>}
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={close}
                    disabled={busy}
                    className="rounded-lg border border-tt-border px-4 py-2 text-sm text-tt-muted hover:text-tt-text disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={busy || password.length === 0}
                    className="rounded-lg bg-tt-cyan px-4 py-2 text-sm font-semibold text-black hover:bg-tt-cyan/90 disabled:opacity-50"
                  >
                    {busy ? 'Verifying…' : 'Exit'}
                  </button>
                </div>
              </form>
            ) : mode === 'oauth' ? (
              <div>
                <p className="text-xs text-tt-muted mt-1">
                  This account signs in with {providerLabel}. Verify with {providerLabel} to leave the
                  time clock.
                </p>
                {error && <p className="mt-2 text-xs text-tt-red">{error}</p>}
                <div className="mt-5 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={close}
                    disabled={busy}
                    className="rounded-lg border border-tt-border px-4 py-2 text-sm text-tt-muted hover:text-tt-text disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={verifyWithOAuth}
                    disabled={busy}
                    className="rounded-lg bg-tt-cyan px-4 py-2 text-sm font-semibold text-black hover:bg-tt-cyan/90 disabled:opacity-50"
                  >
                    {busy ? 'Redirecting…' : `Verify with ${providerLabel}`}
                  </button>
                </div>
              </div>
            ) : (
              <div>
                <p className="text-xs text-tt-muted mt-1">
                  This account can&apos;t be verified for exit here. Use Apple Guided Access to leave
                  kiosk mode, or contact an owner.
                </p>
                <div className="mt-5 flex justify-end">
                  <button
                    type="button"
                    onClick={close}
                    className="rounded-lg border border-tt-border px-4 py-2 text-sm text-tt-muted hover:text-tt-text"
                  >
                    Close
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
