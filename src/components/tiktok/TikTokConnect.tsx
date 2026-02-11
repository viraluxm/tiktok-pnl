'use client';

import { useState, useRef, useEffect } from 'react';
import { useTikTok } from '@/hooks/useTikTok';

export default function TikTokConnect() {
  const {
    isConnected,
    connection,
    isLoading,
    isSyncing,
    lastSyncResult,
    syncError,
    sync,
    disconnect,
    isDisconnecting,
  } = useTikTok();

  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown on outside click
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  if (isLoading) {
    return (
      <div className="mb-4 p-4 rounded-xl border border-tt-border bg-tt-card">
        <div className="flex items-center gap-2 text-tt-muted text-sm">
          <div className="w-4 h-4 border-2 border-tt-muted border-t-transparent rounded-full animate-spin" />
          Loading TikTok connection...
        </div>
      </div>
    );
  }

  if (!isConnected) {
    return (
      <div className="mb-4 p-4 rounded-xl border border-tt-border bg-tt-card">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <TikTokIcon />
            <div>
              <h3 className="text-sm font-semibold text-tt-text">Connect TikTok Shop</h3>
              <p className="text-xs text-tt-muted">Auto-sync ad spend, GMV, and order data</p>
            </div>
          </div>
          <a
            href="/api/tiktok/auth"
            className="px-4 py-2 rounded-lg bg-gradient-to-r from-[#69C9D0] to-[#EE1D52] text-white text-[13px] font-semibold hover:opacity-90 transition-opacity flex items-center gap-2"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
            Connect
          </a>
        </div>
      </div>
    );
  }

  const shopName = connection?.shopName || 'TikTok Shop';

  return (
    <div className="mb-4 flex items-center justify-end">
      <div className="flex items-center gap-2">
        {/* Sync Result / Error */}
        {lastSyncResult && !isSyncing && (
          <span className="text-xs text-tt-muted">
            {lastSyncResult.entriesCreated + lastSyncResult.entriesUpdated} entries synced
          </span>
        )}
        {syncError && !isSyncing && (
          <span className="text-xs text-tt-red">{syncError}</span>
        )}

        {/* Sync button */}
        <button
          onClick={() => sync(30)}
          disabled={isSyncing}
          className="px-2.5 py-1.5 rounded-lg border border-tt-border text-tt-muted text-[11px] font-medium hover:border-tt-cyan hover:text-tt-cyan transition-all disabled:opacity-50 flex items-center gap-1.5"
        >
          {isSyncing ? (
            <>
              <div className="w-3 h-3 border-2 border-tt-cyan border-t-transparent rounded-full animate-spin" />
              Syncing...
            </>
          ) : (
            <>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
              </svg>
              Sync
            </>
          )}
        </button>

        {/* Disconnect button */}
        <button
          onClick={() => {
            if (confirm('Disconnect TikTok? Synced entries will be preserved.')) {
              disconnect();
            }
          }}
          disabled={isDisconnecting}
          className="px-2.5 py-1.5 rounded-lg border border-tt-border text-tt-muted text-[11px] font-medium hover:border-tt-red hover:text-tt-red transition-all disabled:opacity-50"
        >
          Disconnect
        </button>

        {/* Store dropdown */}
        <div ref={dropdownRef} className="relative">
          <button
            onClick={() => setIsOpen(!isOpen)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-tt-border bg-tt-card text-[12px] font-medium text-tt-text hover:border-tt-cyan transition-all cursor-pointer"
          >
            <div className="w-5 h-5 rounded flex items-center justify-center bg-[rgba(105,201,208,0.15)]">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
                <path
                  d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.88-2.89 2.89 2.89 0 0 1 2.88-2.89c.28 0 .56.04.82.1v-3.5a6.37 6.37 0 0 0-.82-.05A6.34 6.34 0 0 0 3.15 15.2a6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.34-6.34V8.87a8.16 8.16 0 0 0 4.76 1.52v-3.4a4.85 4.85 0 0 1-1-.3z"
                  fill="#69C9D0"
                />
              </svg>
            </div>
            <span>{shopName}</span>
            <span className="px-1.5 py-0.5 rounded text-[9px] font-semibold bg-[rgba(0,200,83,0.15)] text-[#00c853] leading-none">
              Connected
            </span>
            <svg
              width="10"
              height="10"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`text-tt-muted transition-transform ${isOpen ? 'rotate-180' : ''}`}
            >
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          {/* Dropdown menu */}
          {isOpen && (
            <div className="absolute right-0 top-full mt-1 w-56 bg-tt-card border border-tt-border rounded-xl shadow-2xl z-50 overflow-hidden">
              {/* Current shop */}
              <div className="py-1">
                <button
                  onClick={() => setIsOpen(false)}
                  className="w-full flex items-center gap-3 px-4 py-2.5 text-left text-[12px] text-tt-text hover:bg-[rgba(255,255,255,0.04)] transition-colors"
                >
                  <div className="w-7 h-7 rounded-lg bg-[rgba(105,201,208,0.1)] border border-[rgba(105,201,208,0.2)] flex items-center justify-center text-[13px]">
                    🏪
                  </div>
                  <span className="font-medium">{shopName}</span>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#69C9D0" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="ml-auto">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </button>
              </div>

              {/* Divider */}
              <div className="border-t border-tt-border" />

              {/* Add store */}
              <a
                href="/api/tiktok/auth"
                className="w-full flex items-center gap-3 px-4 py-2.5 text-left text-[12px] text-tt-cyan hover:bg-[rgba(105,201,208,0.05)] transition-colors"
              >
                <div className="w-7 h-7 rounded-lg border border-dashed border-tt-cyan/40 flex items-center justify-center">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="12" y1="5" x2="12" y2="19" />
                    <line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                </div>
                <span className="font-medium">Add Store</span>
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function TikTokIcon({ connected = false }: { connected?: boolean }) {
  return (
    <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${connected ? 'bg-[rgba(105,201,208,0.15)]' : 'bg-tt-card-hover'}`}>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path
          d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.88-2.89 2.89 2.89 0 0 1 2.88-2.89c.28 0 .56.04.82.1v-3.5a6.37 6.37 0 0 0-.82-.05A6.34 6.34 0 0 0 3.15 15.2a6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.34-6.34V8.87a8.16 8.16 0 0 0 4.76 1.52v-3.4a4.85 4.85 0 0 1-1-.3z"
          fill={connected ? '#69C9D0' : '#888'}
        />
      </svg>
    </div>
  );
}

function formatRelativeTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}
