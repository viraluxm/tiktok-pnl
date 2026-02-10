'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import Image from 'next/image';
import { createClient } from '@/lib/supabase/client';
import { useUser } from '@/hooks/useUser';
import Header from '@/components/layout/Header';

export default function AccountPage() {
  const { user } = useUser();
  const router = useRouter();
  const supabase = createClient();

  // Password change state
  const [showPasswordForm, setShowPasswordForm] = useState(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');
  const [passwordLoading, setPasswordLoading] = useState(false);

  const displayName = user?.user_metadata?.display_name || user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'User';
  const displayEmail = user?.email || '';
  const memberSince = user?.created_at ? new Date(user.created_at).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }) : '—';
  const initial = displayName.charAt(0).toUpperCase();

  async function handlePasswordChange(e: React.FormEvent) {
    e.preventDefault();
    setPasswordError('');
    setPasswordSuccess('');

    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match.');
      return;
    }
    if (newPassword.length < 6) {
      setPasswordError('New password must be at least 6 characters.');
      return;
    }

    setPasswordLoading(true);

    // Verify current password by re-signing in
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email: displayEmail,
      password: currentPassword,
    });

    if (signInError) {
      setPasswordError('Current password is incorrect.');
      setPasswordLoading(false);
      return;
    }

    // Update password
    const { error: updateError } = await supabase.auth.updateUser({
      password: newPassword,
    });

    if (updateError) {
      setPasswordError(updateError.message);
    } else {
      setPasswordSuccess('Password updated successfully.');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setShowPasswordForm(false);
    }
    setPasswordLoading(false);
  }

  // Mock plan data (will be replaced with real subscription data)
  const currentPlan = 'Pro';
  const shopsCount = 1;

  return (
    <div className="min-h-screen bg-tt-bg">
      <Header />

      <div className="p-6 max-w-2xl mx-auto">
        {/* Back button */}
        <button
          onClick={() => router.push('/dashboard')}
          className="flex items-center gap-1.5 text-tt-muted text-sm hover:text-tt-text transition-colors mb-6"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6"/>
          </svg>
          Back to Dashboard
        </button>

        <h1 className="text-2xl font-bold text-tt-text mb-2">My Account</h1>
        <p className="text-sm text-tt-muted mb-8">Manage your account information and settings</p>

        <div className="space-y-0">
          {/* Email */}
          <AccountRow
            icon={<MailIcon />}
            label="Email Address"
            value={displayEmail}
          />

          {/* Name */}
          <AccountRow
            icon={<UserIcon />}
            label="Name"
            value={displayName}
          />

          {/* Password */}
          <div className="border-b border-tt-border py-6">
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-3">
                <span className="text-tt-muted mt-0.5"><LockIcon /></span>
                <div>
                  <p className="text-xs text-tt-muted uppercase tracking-wide mb-1">Password</p>
                  <p className="text-tt-text text-sm tracking-widest">{'••••••••'}</p>
                </div>
              </div>
              <button
                onClick={() => setShowPasswordForm(!showPasswordForm)}
                className="px-3 py-1.5 rounded-lg border border-tt-border text-tt-text text-xs font-medium hover:bg-tt-card-hover transition-all flex items-center gap-1.5"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                  <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                </svg>
                Change
              </button>
            </div>

            {/* Password Change Form */}
            {showPasswordForm && (
              <form onSubmit={handlePasswordChange} className="mt-4 ml-7 space-y-3">
                <div>
                  <label className="block text-xs text-tt-muted mb-1">Current Password</label>
                  <input
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    required
                    className="w-full bg-tt-input-bg border border-tt-input-border text-tt-text px-3 py-2 rounded-lg text-sm focus:outline-none focus:border-tt-cyan transition-colors"
                    placeholder="Enter current password"
                  />
                </div>
                <div>
                  <label className="block text-xs text-tt-muted mb-1">New Password</label>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                    className="w-full bg-tt-input-bg border border-tt-input-border text-tt-text px-3 py-2 rounded-lg text-sm focus:outline-none focus:border-tt-cyan transition-colors"
                    placeholder="Enter new password"
                  />
                </div>
                <div>
                  <label className="block text-xs text-tt-muted mb-1">Confirm New Password</label>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    className="w-full bg-tt-input-bg border border-tt-input-border text-tt-text px-3 py-2 rounded-lg text-sm focus:outline-none focus:border-tt-cyan transition-colors"
                    placeholder="Confirm new password"
                  />
                </div>
                {passwordError && <p className="text-tt-red text-xs">{passwordError}</p>}
                {passwordSuccess && <p className="text-tt-green text-xs">{passwordSuccess}</p>}
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={passwordLoading}
                    className="px-4 py-2 rounded-lg bg-tt-cyan text-black text-xs font-semibold hover:opacity-90 transition-opacity disabled:opacity-50"
                  >
                    {passwordLoading ? 'Updating...' : 'Update Password'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setShowPasswordForm(false); setPasswordError(''); setPasswordSuccess(''); }}
                    className="px-4 py-2 rounded-lg border border-tt-border text-tt-muted text-xs font-medium hover:bg-tt-card-hover transition-all"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            )}
          </div>

          {/* Current Plan */}
          <div className="border-b border-tt-border py-6">
            <div className="flex items-start justify-between">
              <div className="flex items-start gap-3">
                <span className="text-tt-muted mt-0.5"><PlanIcon /></span>
                <div>
                  <p className="text-xs text-tt-muted uppercase tracking-wide mb-1">Current Plan</p>
                  <p className="text-tt-text font-semibold">{currentPlan}</p>
                  <p className="text-xs text-tt-cyan">{shopsCount} {shopsCount === 1 ? 'Shop' : 'Shops'} Active</p>
                </div>
              </div>
              <button
                onClick={() => router.push('/plans')}
                className="px-3 py-1.5 rounded-lg border border-tt-border text-tt-text text-xs font-medium hover:bg-tt-card-hover transition-all flex items-center gap-1.5"
              >
                <PlanIcon size={12} />
                Manage Plan
              </button>
            </div>
          </div>

          {/* Member Since */}
          <AccountRow
            icon={<CalendarIcon />}
            label="Member Since"
            value={memberSince}
          />
        </div>
      </div>
    </div>
  );
}

function AccountRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="border-b border-tt-border py-6">
      <div className="flex items-start gap-3">
        <span className="text-tt-muted mt-0.5">{icon}</span>
        <div>
          <p className="text-xs text-tt-muted uppercase tracking-wide mb-1">{label}</p>
          <p className="text-tt-text text-sm font-medium">{value}</p>
        </div>
      </div>
    </div>
  );
}

function MailIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/>
      <polyline points="22,6 12,13 2,6"/>
    </svg>
  );
}

function UserIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
      <circle cx="12" cy="7" r="4"/>
    </svg>
  );
}

function LockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
      <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
    </svg>
  );
}

function PlanIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="5" width="20" height="14" rx="2"/>
      <line x1="2" y1="10" x2="22" y2="10"/>
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
      <line x1="16" y1="2" x2="16" y2="6"/>
      <line x1="8" y1="2" x2="8" y2="6"/>
      <line x1="3" y1="10" x2="21" y2="10"/>
    </svg>
  );
}
