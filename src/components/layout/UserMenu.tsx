'use client';

import { useState, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useUser } from '@/hooks/useUser';
import { useDemo } from '@/lib/demo/context';

export default function UserMenu() {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const supabase = createClient();
  const { user } = useUser();
  const { isDemo, exitDemo } = useDemo();

  // Close menu when clicking outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  async function handleSignOut() {
    if (isDemo) exitDemo();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  const displayName = user?.user_metadata?.display_name || user?.user_metadata?.full_name || user?.email?.split('@')[0] || 'User';
  const displayEmail = user?.email || '';
  const initial = displayName.charAt(0).toUpperCase();

  return (
    <div className="relative" ref={menuRef}>
      {/* Avatar Button */}
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2.5 px-2 py-1.5 rounded-xl hover:bg-tt-card-hover transition-all cursor-pointer"
      >
        <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#4F46E5] to-[#69C9D0] flex items-center justify-center text-white text-sm font-bold">
          {initial}
        </div>
        <div className="hidden sm:block text-left">
          <p className="text-xs font-medium text-tt-text leading-tight">{displayName}</p>
          <p className="text-[10px] text-tt-muted leading-tight">{displayEmail}</p>
        </div>
        {/* Three dots */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" className="text-tt-muted ml-0.5">
          <circle cx="12" cy="5" r="1.5" fill="currentColor"/>
          <circle cx="12" cy="12" r="1.5" fill="currentColor"/>
          <circle cx="12" cy="19" r="1.5" fill="currentColor"/>
        </svg>
      </button>

      {/* Dropdown Menu */}
      {open && (
        <div className="absolute right-0 top-full mt-2 w-56 bg-[#1a1a1a] border border-tt-border rounded-xl shadow-2xl shadow-black/40 overflow-hidden z-[100] animate-fade-in">
          {/* User Info Header */}
          <div className="px-4 py-3 border-b border-tt-border">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-full bg-gradient-to-br from-[#4F46E5] to-[#69C9D0] flex items-center justify-center text-white text-sm font-bold shrink-0">
                {initial}
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-tt-text truncate">{displayName}</p>
                <p className="text-[11px] text-tt-muted truncate">{displayEmail}</p>
              </div>
            </div>
          </div>

          {/* Menu Items */}
          <div className="py-1.5">
            <MenuItem
              icon={<UserIcon />}
              label="My Account"
              onClick={() => { setOpen(false); router.push('/account'); }}
            />
            <MenuItem
              icon={<ShopIcon />}
              label="My Shops"
              onClick={() => { setOpen(false); router.push('/dashboard'); }}
            />
            <MenuItem
              icon={<HelpIcon />}
              label="Help"
              onClick={() => { setOpen(false); window.open('mailto:support@lensed.io', '_blank'); }}
            />
          </div>

          {/* Logout */}
          <div className="border-t border-tt-border py-1.5">
            <MenuItem
              icon={<LogoutIcon />}
              label="Log Out"
              onClick={handleSignOut}
              danger
            />
          </div>
        </div>
      )}
    </div>
  );
}

function MenuItem({ icon, label, onClick, danger = false }: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-3 px-4 py-2.5 text-sm transition-colors ${
        danger
          ? 'text-tt-red hover:bg-[rgba(255,23,68,0.08)]'
          : 'text-tt-text hover:bg-white/[0.04]'
      }`}
    >
      <span className={danger ? 'text-tt-red' : 'text-tt-muted'}>{icon}</span>
      {label}
    </button>
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

function ShopIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>
      <polyline points="9 22 9 12 15 12 15 22"/>
    </svg>
  );
}

function HelpIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10"/>
      <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
      <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
  );
}

function LogoutIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
      <polyline points="16 17 21 12 16 7"/>
      <line x1="21" y1="12" x2="9" y2="12"/>
    </svg>
  );
}
