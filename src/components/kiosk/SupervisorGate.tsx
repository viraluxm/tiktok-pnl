'use client';

import { useState, type FormEvent } from 'react';

// Supervisor (store-owner) password gate. Verifies server-side via /api/kiosk/supervisor-verify,
// which establishes NO session and sets NO cookie (see the route + verifySupervisorIsOwner). On
// success it hands the entered credentials back to the parent — used by the manual-override flow to
// authorise each punch, and by the exit/lock flow (which then signs the kiosk account out). The
// credentials live only in parent React state for the brief override session and are never persisted.
//
// The email/password inputs are real text fields, so the BadgeKiosk scan buffer (which ignores
// keystrokes whenever a text field is focused) never swallows what the supervisor types here.
export default function SupervisorGate({
  title,
  submitLabel = 'Verify',
  onCancel,
  onVerified,
}: {
  title: string;
  submitLabel?: string;
  onCancel: () => void;
  onVerified: (email: string, password: string) => void | Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/kiosk/supervisor-verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean };
      if (res.ok && j.ok) {
        await onVerified(email, password);
      } else if (res.status === 429) {
        setError('Too many attempts. Wait a moment and try again.');
      } else {
        setError('Supervisor not recognized.');
      }
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <form onSubmit={submit} className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-2xl">
        <h2 className="mb-1 text-xl font-semibold text-gray-900">{title}</h2>
        <p className="mb-4 text-sm text-gray-500">
          Supervisor sign-in required. This verifies you without signing in on this device.
        </p>
        <input
          type="email"
          inputMode="email"
          autoComplete="off"
          placeholder="Supervisor email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className="mb-2 w-full rounded-lg border border-gray-300 px-3 py-3 text-gray-900 outline-none focus:border-gray-900"
          autoFocus
        />
        <input
          type="password"
          autoComplete="off"
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-3 w-full rounded-lg border border-gray-300 px-3 py-3 text-gray-900 outline-none focus:border-gray-900"
        />
        {error && (
          <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-700">{error}</p>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 rounded-lg border border-gray-300 px-4 py-3 font-medium text-gray-700"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={busy || !email || !password}
            className="flex-1 rounded-lg bg-gray-900 px-4 py-3 font-medium text-white disabled:opacity-50"
          >
            {busy ? 'Checking…' : submitLabel}
          </button>
        </div>
      </form>
    </div>
  );
}
