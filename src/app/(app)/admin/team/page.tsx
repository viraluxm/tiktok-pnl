'use client';

import { useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useStores } from '@/hooks/useStores';

// The two roles this page can create. Labels are what the admin sees; the value
// is the exact string written to app_metadata.role — never anything else.
const ROLE_OPTIONS = [
  { value: 'member', label: 'Team member' },
  { value: 'station', label: 'Fulfillment station' },
  { value: 'timeclock', label: 'Time clock kiosk' },
] as const;
type ManagedRole = (typeof ROLE_OPTIONS)[number]['value'];

const ROLE_LABEL: Record<string, string> = {
  member: 'Team member',
  station: 'Fulfillment station',
  timeclock: 'Time clock kiosk',
};

// Member capability scopes — must match KNOWN_MEMBER_SCOPES on the server and the middleware
// allowlist. Each is a /team page + its owner-scoped /api/member/* routes.
const SCOPE_OPTIONS = [
  { value: 'binding', label: 'Binding' },
  { value: 'inventory', label: 'Inventory' },
  { value: 'pnl', label: 'P&L' },
  { value: 'shows', label: 'Shows' },
  { value: 'team', label: 'Team' },
] as const;
const SCOPE_LABEL: Record<string, string> = { binding: 'Binding', inventory: 'Inventory', pnl: 'P&L', shows: 'Shows', team: 'Team' };

interface TeamMember {
  id: string;
  email: string | null;
  role: ManagedRole;
  store_id: string | null;   // station: single assigned store
  stores: string[] | null;   // member: multiple assigned stores
  scopes: string[] | null;   // member: capability scopes
  last_sign_in_at: string | null;
  banned_until: string | null;
}

function isDisabled(bannedUntil: string | null): boolean {
  if (!bannedUntil) return false;
  const t = Date.parse(bannedUntil);
  return Number.isFinite(t) && t > Date.now();
}

function fmtDate(iso: string | null): string {
  if (!iso) return 'Never';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '—';
  return new Date(t).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function useTeam() {
  return useQuery<{ members: TeamMember[] }>({
    queryKey: ['admin-team'],
    retry: false,
    staleTime: 15_000,
    queryFn: async () => {
      const res = await fetch('/api/admin/team');
      if (!res.ok) throw new Error(res.status === 403 ? 'forbidden' : 'Failed to load team');
      return res.json();
    },
  });
}

export default function TeamPage() {
  const qc = useQueryClient();
  const { data, isLoading, isError } = useTeam();
  const { data: storesData } = useStores();

  const stores = useMemo(() => storesData?.stores ?? [], [storesData]);
  const storeName = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of stores) m.set(s.id, s.name);
    return (id: string | null) => (id ? m.get(id) ?? id : '—');
  }, [stores]);

  // Create form. Station is not store-scoped (warehouse handles all stores);
  // a member is assigned one or more stores.
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<ManagedRole>('member');
  const [storeIds, setStoreIds] = useState<string[]>([]); // member (multiple)
  const [allStores, setAllStores] = useState(true);       // member: "All stores" toggle (default on)
  const [scopeSel, setScopeSel] = useState<string[]>(['binding']); // member: capability scopes
  const [editScopesId, setEditScopesId] = useState<string | null>(null); // row whose scopes are being edited
  const [editScopeSel, setEditScopeSel] = useState<string[]>([]);
  const [banner, setBanner] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const [newPassword, setNewPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const create = useMutation({
    mutationFn: async () => {
      // Branch the payload on role: a station is not store-scoped (warehouse
      // handles all stores) so it sends NO store field; a member sends the '*'
      // sentinel when "All stores" is checked, else the selected store ids.
      const body =
        role === 'station'
          ? { email, role }
          : role === 'timeclock'
            ? { email, role, stores: storeIds } // kiosk: one concrete store, no capability scopes
            : { email, role, stores: allStores ? ['*'] : storeIds, scopes: scopeSel };
      const res = await fetch('/api/admin/team', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to create user');
      return json as { password: string; user: { email: string } };
    },
    onSuccess: (json) => {
      setNewPassword(json.password);
      setCopied(false);
      setBanner({ kind: 'success', text: `Created ${json.user.email}` });
      setEmail('');
      setStoreIds([]);
      setAllStores(true);
      setScopeSel(['binding']);
      setRole('member');
      qc.invalidateQueries({ queryKey: ['admin-team'] });
    },
    onError: (e: Error) => {
      setNewPassword(null);
      setBanner({ kind: 'error', text: e.message });
    },
  });

  const toggle = useMutation({
    mutationFn: async (vars: { id: string; action: 'disable' | 'enable' }) => {
      const res = await fetch(`/api/admin/team/${vars.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: vars.action }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to update user');
      return json;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['admin-team'] }),
    onError: (e: Error) => setBanner({ kind: 'error', text: e.message }),
  });

  // Reset a sub-user's password. The server generates it and returns it ONCE — reuse the same
  // temporary-password card the create flow shows.
  const reset = useMutation({
    mutationFn: async (vars: { id: string; email: string }) => {
      const res = await fetch(`/api/admin/team/${vars.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'reset_password' }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to reset password');
      return json as { password: string };
    },
    onSuccess: (json, vars) => {
      setNewPassword(json.password);
      setCopied(false);
      setBanner({ kind: 'success', text: `New password for ${vars.email || 'user'} — copy it below.` });
    },
    onError: (e: Error) => setBanner({ kind: 'error', text: e.message }),
  });

  // Change an existing member's capability scopes in place (PATCH set_scopes). Without this the
  // only way to grant a new scope to an existing member is delete-and-recreate.
  const setScopes = useMutation({
    mutationFn: async (vars: { id: string; scopes: string[] }) => {
      const res = await fetch(`/api/admin/team/${vars.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'set_scopes', scopes: vars.scopes }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to update scopes');
      return json;
    },
    onSuccess: () => {
      setEditScopesId(null);
      qc.invalidateQueries({ queryKey: ['admin-team'] });
    },
    onError: (e: Error) => setBanner({ kind: 'error', text: e.message }),
  });

  async function copyPassword() {
    if (!newPassword) return;
    try {
      await navigator.clipboard.writeText(newPassword);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const members = data?.members ?? [];

  return (
    <div className="mx-auto max-w-4xl p-6 space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-tt-text">Team</h1>
        <p className="text-xs text-tt-muted mt-1 max-w-2xl">
          Team members and fulfillment stations. Each sub-user is confined to
          their own area and the store you assign here.
        </p>
      </div>

      {banner && (
        <div
          className={`rounded-lg px-4 py-2 text-sm ${
            banner.kind === 'error' ? 'bg-tt-red/10 text-tt-red' : 'bg-tt-green/10 text-tt-green'
          }`}
        >
          {banner.text}
        </div>
      )}

      {/* One-time password reveal */}
      {newPassword && (
        <div className="rounded-[14px] border border-tt-cyan/30 bg-tt-cyan/5 p-5 space-y-3">
          <p className="text-sm font-semibold text-tt-text">Temporary password</p>
          <p className="text-xs text-tt-muted">
            Copy this now — it is shown only once and cannot be retrieved again. Share it
            with the new user; they can change it after signing in.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 rounded-lg border border-tt-border bg-black/30 px-3 py-2 text-sm text-tt-text break-all">
              {newPassword}
            </code>
            <button
              onClick={copyPassword}
              className="rounded-lg bg-tt-cyan px-4 py-2 text-sm font-semibold text-black hover:opacity-90 whitespace-nowrap"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
            <button
              onClick={() => setNewPassword(null)}
              className="rounded-lg border border-tt-border px-3 py-2 text-sm text-tt-muted hover:text-tt-text"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* LIST */}
      <section className="rounded-[14px] border border-tt-border bg-tt-card overflow-hidden">
        <div className="px-5 py-4 border-b border-tt-border">
          <h2 className="text-base font-semibold text-tt-text">Sub-users</h2>
        </div>
        <div className="p-5">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-tt-border">
                  <th className="text-left px-3 py-2 text-[11px] text-tt-muted uppercase tracking-wide">Email</th>
                  <th className="text-left px-3 py-2 text-[11px] text-tt-muted uppercase tracking-wide">Role</th>
                  <th className="text-left px-3 py-2 text-[11px] text-tt-muted uppercase tracking-wide">Store</th>
                  <th className="text-left px-3 py-2 text-[11px] text-tt-muted uppercase tracking-wide">Scopes</th>
                  <th className="text-left px-3 py-2 text-[11px] text-tt-muted uppercase tracking-wide">Last sign-in</th>
                  <th className="text-left px-3 py-2 text-[11px] text-tt-muted uppercase tracking-wide">Status</th>
                  <th className="text-right px-3 py-2 text-[11px] text-tt-muted uppercase tracking-wide">Actions</th>
                </tr>
              </thead>
              <tbody>
                {isLoading && (
                  <tr><td colSpan={7} className="px-3 py-6 text-center text-sm text-tt-muted">Loading…</td></tr>
                )}
                {isError && !isLoading && (
                  <tr><td colSpan={7} className="px-3 py-6 text-center text-sm text-tt-red">Failed to load team.</td></tr>
                )}
                {!isLoading && !isError && members.length === 0 && (
                  <tr><td colSpan={7} className="px-3 py-6 text-center text-sm text-tt-muted">No sub-users yet.</td></tr>
                )}
                {members.map((m) => {
                  const disabled = isDisabled(m.banned_until);
                  const busy = toggle.isPending && toggle.variables?.id === m.id;
                  const resetBusy = reset.isPending && reset.variables?.id === m.id;
                  return (
                    <tr key={m.id} className="border-b border-[rgba(255,255,255,0.04)]">
                      <td className="px-3 py-2 text-[13px] text-tt-text">{m.email ?? '—'}</td>
                      <td className="px-3 py-2 text-[13px] text-tt-text">{ROLE_LABEL[m.role] ?? m.role}</td>
                      <td className="px-3 py-2 text-[13px] text-tt-text">
                        {m.role === 'station' || m.stores?.includes('*')
                          ? 'All stores'
                          : m.stores?.length
                            ? m.stores.map((id) => storeName(id)).join(', ')
                            : storeName(m.store_id)}
                      </td>
                      <td className="px-3 py-2 text-[13px]">
                        {m.role !== 'member' ? (
                          <span className="text-tt-muted">—</span>
                        ) : editScopesId === m.id ? (
                          <div className="flex flex-col gap-1">
                            {SCOPE_OPTIONS.map((s) => (
                              <label key={s.value} className="flex items-center gap-1.5 text-[12px] text-tt-text cursor-pointer select-none">
                                <input
                                  type="checkbox"
                                  checked={editScopeSel.includes(s.value)}
                                  onChange={(e) =>
                                    setEditScopeSel((prev) =>
                                      e.target.checked
                                        ? [...new Set([...prev, s.value])]
                                        : prev.filter((v) => v !== s.value),
                                    )
                                  }
                                  className="h-3.5 w-3.5 accent-tt-cyan"
                                />
                                {s.label}
                              </label>
                            ))}
                            <div className="flex gap-1 mt-1">
                              <button
                                onClick={() => setScopes.mutate({ id: m.id, scopes: editScopeSel })}
                                disabled={editScopeSel.length === 0 || (setScopes.isPending && setScopes.variables?.id === m.id)}
                                className="px-2 py-0.5 rounded text-[11px] font-semibold bg-tt-cyan/15 text-tt-cyan hover:bg-tt-cyan/25 disabled:opacity-40"
                              >
                                {setScopes.isPending && setScopes.variables?.id === m.id ? '…' : 'Save'}
                              </button>
                              <button
                                onClick={() => setEditScopesId(null)}
                                className="px-2 py-0.5 rounded text-[11px] text-tt-muted hover:text-tt-text"
                              >
                                Cancel
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-center gap-2">
                            <span className="flex flex-wrap gap-1">
                              {m.scopes?.length
                                ? m.scopes.map((s) => (
                                    <span key={s} className="rounded-full bg-tt-card-hover px-2 py-0.5 text-[11px] text-tt-text">
                                      {SCOPE_LABEL[s] ?? s}
                                    </span>
                                  ))
                                : <span className="text-tt-muted">none</span>}
                            </span>
                            <button
                              onClick={() => { setEditScopesId(m.id); setEditScopeSel(m.scopes ?? []); }}
                              className="text-[11px] text-tt-cyan hover:underline"
                            >
                              Edit
                            </button>
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-[13px] text-tt-muted tabular-nums">{fmtDate(m.last_sign_in_at)}</td>
                      <td className="px-3 py-2 text-[13px]">
                        <span className={disabled ? 'text-tt-red' : 'text-tt-green'}>
                          {disabled ? 'Disabled' : 'Active'}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <div className="inline-flex items-center gap-2">
                          <button
                            onClick={() => reset.mutate({ id: m.id, email: m.email ?? '' })}
                            disabled={resetBusy}
                            className="px-3 py-1 rounded-lg text-[11px] font-semibold bg-tt-cyan/15 text-tt-cyan hover:bg-tt-cyan/25 disabled:opacity-40"
                          >
                            {resetBusy ? '…' : 'Reset password'}
                          </button>
                          <button
                            onClick={() => toggle.mutate({ id: m.id, action: disabled ? 'enable' : 'disable' })}
                            disabled={busy}
                            className={`px-3 py-1 rounded-lg text-[11px] font-semibold disabled:opacity-40 ${
                              disabled
                                ? 'bg-tt-green/15 text-tt-green hover:bg-tt-green/25'
                                : 'bg-tt-red/15 text-tt-red hover:bg-tt-red/25'
                            }`}
                          >
                            {busy ? '…' : disabled ? 'Enable' : 'Disable'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* CREATE */}
      <section className="rounded-[14px] border border-tt-border bg-tt-card overflow-hidden">
        <div className="px-5 py-4 border-b border-tt-border">
          <h2 className="text-base font-semibold text-tt-text">Add sub-user</h2>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <label className="block">
              <span className="block text-[11px] text-tt-muted uppercase tracking-wide mb-1">Email</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="person@example.com"
                className="w-full rounded-lg border border-tt-border bg-white/5 px-3 py-2 text-sm text-tt-text outline-none focus:ring-1 focus:ring-tt-cyan/50"
              />
            </label>
            <label className="block">
              <span className="block text-[11px] text-tt-muted uppercase tracking-wide mb-1">Role</span>
              <select
                value={role}
                onChange={(e) => {
                  // Switching role clears any member store selection so a stale
                  // stores[] can never ride along with a station submit, and resets
                  // "All stores" to its default (on).
                  setRole(e.target.value as ManagedRole);
                  setStoreIds([]);
                  setAllStores(true);
                  setScopeSel(['binding']);
                }}
                className="w-full rounded-lg border border-tt-border bg-white/5 px-3 py-2 text-sm text-tt-text outline-none focus:ring-1 focus:ring-tt-cyan/50 appearance-none"
              >
                {ROLE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value} className="bg-tt-card">{o.label}</option>
                ))}
              </select>
            </label>
            {/* Station is not store-scoped (all stores), so it has no store control.
                A member is "All stores" ('*') by default, or a specific set. */}
            {role === 'member' && (
              <div className="block">
                <span className="block text-[11px] text-tt-muted uppercase tracking-wide mb-1">Stores</span>
                <label className="flex items-center gap-2 mb-2 text-sm text-tt-text cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={allStores}
                    onChange={(e) => setAllStores(e.target.checked)}
                    className="h-4 w-4 accent-tt-cyan"
                  />
                  All stores
                </label>
                <select
                  multiple
                  value={storeIds}
                  onChange={(e) =>
                    setStoreIds(Array.from(e.target.selectedOptions, (o) => o.value))
                  }
                  disabled={allStores}
                  className={`w-full h-24 rounded-lg border border-tt-border bg-white/5 px-3 py-2 text-sm text-tt-text outline-none focus:ring-1 focus:ring-tt-cyan/50 ${allStores ? 'opacity-40 pointer-events-none' : ''}`}
                >
                  {stores.map((s) => (
                    <option key={s.id} value={s.id} className="bg-tt-card">{s.name}</option>
                  ))}
                </select>
                {!allStores && (
                  <span className="mt-1 block text-[11px] text-tt-muted">Pick one or more stores</span>
                )}
              </div>
            )}
            {/* Time-clock kiosk — one physical location → exactly one required store. It carries no
                capability scopes; the owner is resolved from this store's store_members(role='owner'). */}
            {role === 'timeclock' && (
              <div className="block">
                <span className="block text-[11px] text-tt-muted uppercase tracking-wide mb-1">Store</span>
                <select
                  value={storeIds[0] ?? ''}
                  onChange={(e) => setStoreIds(e.target.value ? [e.target.value] : [])}
                  className="w-full rounded-lg border border-tt-border bg-white/5 px-3 py-2 text-sm text-tt-text outline-none focus:ring-1 focus:ring-tt-cyan/50 appearance-none"
                >
                  <option value="" className="bg-tt-card">Select a store…</option>
                  {stores.map((s) => (
                    <option key={s.id} value={s.id} className="bg-tt-card">{s.name}</option>
                  ))}
                </select>
                <span className="mt-1 block text-[11px] text-tt-muted">The kiosk resolves its owner from this store.</span>
              </div>
            )}
            {/* Member capability scopes — at least one required. */}
            {role === 'member' && (
              <div className="block">
                <span className="block text-[11px] text-tt-muted uppercase tracking-wide mb-1">Scopes</span>
                <div className="flex flex-col gap-2">
                  {SCOPE_OPTIONS.map((s) => (
                    <label key={s.value} className="flex items-center gap-2 text-sm text-tt-text cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={scopeSel.includes(s.value)}
                        onChange={(e) =>
                          setScopeSel((prev) =>
                            e.target.checked
                              ? [...new Set([...prev, s.value])]
                              : prev.filter((v) => v !== s.value),
                          )
                        }
                        className="h-4 w-4 accent-tt-cyan"
                      />
                      {s.label}
                    </label>
                  ))}
                </div>
                {scopeSel.length === 0 && (
                  <span className="mt-1 block text-[11px] text-tt-red">Pick at least one scope</span>
                )}
              </div>
            )}
          </div>
          <button
            onClick={() => { setBanner(null); create.mutate(); }}
            disabled={
              create.isPending ||
              !email ||
              (role === 'member' && !allStores && storeIds.length === 0) ||
              (role === 'member' && scopeSel.length === 0)
            }
            className="rounded-lg bg-tt-cyan px-4 py-2 text-sm font-semibold text-black hover:opacity-90 disabled:opacity-40"
          >
            {create.isPending ? 'Creating…' : 'Create sub-user'}
          </button>
        </div>
      </section>
    </div>
  );
}
