'use client';

import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useUser } from '@/hooks/useUser';

interface HeaderProps {
  onExportCSV: () => void;
  onImportCSV: () => void;
  onClearAll: () => void;
}

export default function Header({ onExportCSV, onImportCSV, onClearAll }: HeaderProps) {
  const router = useRouter();
  const supabase = createClient();
  const { user } = useUser();

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push('/');
    router.refresh();
  }

  return (
    <div className="flex items-center justify-between px-6 py-4 border-b border-tt-border bg-[rgba(15,15,15,0.95)] backdrop-blur-xl sticky top-0 z-50">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 bg-gradient-to-br from-tt-cyan to-[#4F46E5] rounded-[10px] flex items-center justify-center">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/>
            <path d="M2 12h20"/>
          </svg>
        </div>
        <h1 className="text-lg font-bold">
          Lensed
        </h1>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={onExportCSV} className="px-4 py-2 rounded-lg border border-tt-border bg-tt-card text-tt-text text-[13px] font-medium hover:bg-tt-card-hover hover:border-tt-border-hover transition-all flex items-center gap-1.5">
          Export CSV
        </button>
        <button onClick={onImportCSV} className="px-4 py-2 rounded-lg border border-tt-border bg-tt-card text-tt-text text-[13px] font-medium hover:bg-tt-card-hover hover:border-tt-border-hover transition-all flex items-center gap-1.5">
          Import CSV
        </button>
        <button onClick={onClearAll} className="px-4 py-2 rounded-lg border border-tt-red text-tt-red text-[13px] font-medium hover:bg-[rgba(255,23,68,0.1)] transition-all">
          Clear All
        </button>
        {user && (
          <span className="text-tt-muted text-xs ml-2 hidden sm:inline">{user.email}</span>
        )}
        <button onClick={handleSignOut} className="px-4 py-2 rounded-lg border border-tt-border bg-tt-card text-tt-text text-[13px] font-medium hover:bg-tt-card-hover transition-all ml-1">
          Sign Out
        </button>
      </div>
    </div>
  );
}
