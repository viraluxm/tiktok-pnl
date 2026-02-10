'use client';

import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { useDemo } from '@/lib/demo/context';

export default function DemoBanner() {
  const { isDemo, exitDemo } = useDemo();
  const router = useRouter();
  const supabase = createClient();

  if (!isDemo) return null;

  async function handleExit() {
    exitDemo();
    await supabase.auth.signOut();
    router.push('/login');
    router.refresh();
  }

  return (
    <div className="bg-gradient-to-r from-[#EE1D52]/20 to-[#69C9D0]/20 border-b border-[#EE1D52]/30">
      <div className="max-w-[1600px] mx-auto px-6 py-2.5 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-bold uppercase tracking-wider bg-[#EE1D52]/20 text-[#EE1D52] border border-[#EE1D52]/30">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polygon points="5 3 19 12 5 21 5 3" />
            </svg>
            Demo
          </span>
          <span className="text-xs text-tt-muted">
            You&apos;re viewing sample data from <strong className="text-tt-text">Demo Store</strong> — this is how a connected TikTok Shop looks
          </span>
        </div>
        <div className="flex items-center gap-3">
          <a
            href="/signup"
            onClick={async (e) => { e.preventDefault(); exitDemo(); await supabase.auth.signOut(); router.push('/signup'); router.refresh(); }}
            className="text-xs text-tt-cyan hover:underline font-medium"
          >
            Create Account
          </a>
          <button
            onClick={handleExit}
            className="text-xs text-tt-muted hover:text-tt-text transition-colors"
          >
            Exit Demo
          </button>
        </div>
      </div>
    </div>
  );
}
