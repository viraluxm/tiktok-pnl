'use client';

import { useDemoTikTok } from '@/hooks/useDemoTikTok';

export default function DemoTikTokConnect() {
  const {
    connection,
    isSyncing,
    lastSyncResult,
    sync,
  } = useDemoTikTok();

  return (
    <div className="mb-4 p-4 rounded-xl border border-tt-border bg-tt-card">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <TikTokIcon />
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-semibold text-tt-text">
                {connection?.shopName || 'TikTok Shop'}
              </h3>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-[rgba(0,200,83,0.15)] text-[#00c853]">
                Connected
              </span>
              <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-[#EE1D52]/15 text-[#EE1D52]">
                Demo
              </span>
            </div>
            <p className="text-xs text-tt-muted">
              {connection?.advertiserCount || 0} advertiser{(connection?.advertiserCount || 0) !== 1 ? 's' : ''}
              {connection?.lastSyncedAt && (
                <> &middot; Last synced {formatRelativeTime(connection.lastSyncedAt)}</>
              )}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {lastSyncResult && !isSyncing && (
            <span className="text-xs text-tt-muted">
              {lastSyncResult.entriesCreated + lastSyncResult.entriesUpdated} entries synced
            </span>
          )}

          <button
            onClick={() => sync(30)}
            disabled={isSyncing}
            className="px-3 py-1.5 rounded-lg border border-tt-cyan text-tt-cyan text-[12px] font-medium hover:bg-[rgba(105,201,208,0.1)] transition-all disabled:opacity-50 flex items-center gap-1.5"
          >
            {isSyncing ? (
              <>
                <div className="w-3 h-3 border-2 border-tt-cyan border-t-transparent rounded-full animate-spin" />
                Syncing...
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
                </svg>
                Sync Now
              </>
            )}
          </button>

          <button
            disabled
            className="px-3 py-1.5 rounded-lg border border-tt-border text-tt-muted text-[12px] font-medium opacity-50 cursor-not-allowed"
            title="Disconnect is disabled in demo mode"
          >
            Disconnect
          </button>
        </div>
      </div>
    </div>
  );
}

function TikTokIcon() {
  return (
    <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-[rgba(105,201,208,0.15)]">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
        <path
          d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-2.88 2.5 2.89 2.89 0 0 1-2.88-2.89 2.89 2.89 0 0 1 2.88-2.89c.28 0 .56.04.82.1v-3.5a6.37 6.37 0 0 0-.82-.05A6.34 6.34 0 0 0 3.15 15.2a6.34 6.34 0 0 0 6.34 6.34 6.34 6.34 0 0 0 6.34-6.34V8.87a8.16 8.16 0 0 0 4.76 1.52v-3.4a4.85 4.85 0 0 1-1-.3z"
          fill="#69C9D0"
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
