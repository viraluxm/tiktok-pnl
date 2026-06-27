'use client';

import { useState } from 'react';
import { COMMENTS } from './simulatorData';
import { randomUsername, type TrainerEvent } from './trainerEvents';
import { useSessionChannel } from '@/lib/training/useSessionChannel';

export default function ControlClient({ sessionId }: { sessionId: string }) {
  const [customText, setCustomText] = useState('');
  const [auctionRunning, setAuctionRunning] = useState(false);
  const [currentBid, setCurrentBid] = useState(0);
  const [currentWinner, setCurrentWinner] = useState<string | null>(null);

  const { status, peerPresent, send } = useSessionChannel(sessionId, 'controller', (event: TrainerEvent) => {
    if (event.action === 'auctionState') {
      setAuctionRunning(event.running);
      setCurrentBid(event.bid);
      setCurrentWinner(event.winner);
    }
  });

  const connected = status === 'connected';

  function sendComment(text: string) {
    const trimmed = text.trim();
    if (!trimmed || !connected) return;
    send({ action: 'comment', username: randomUsername(), text: trimmed });
  }

  function handleCustomSend() {
    sendComment(customText);
    setCustomText('');
  }

  // Connection indicator
  let connLabel = 'Connecting…';
  let connColor = 'text-tt-yellow';
  if (status === 'error') {
    connLabel = 'Connection error';
    connColor = 'text-tt-red';
  } else if (connected) {
    connLabel = peerPresent ? 'Host connected' : 'Waiting for host…';
    connColor = peerPresent ? 'text-tt-green' : 'text-tt-muted';
  }

  return (
    <div className="min-h-[100dvh] bg-tt-bg px-4 py-6 text-tt-text">
      <div className="mx-auto w-full max-w-md space-y-4">
        <header className="flex items-center justify-between">
          <h1 className="text-lg font-bold">Practice Controller</h1>
          <span className={`flex items-center gap-1.5 text-[13px] font-medium ${connColor}`}>
            <span className="h-2 w-2 rounded-full bg-current" />
            {connLabel}
          </span>
        </header>

        {/* Auction controls */}
        <section className="space-y-3 rounded-2xl border border-tt-border bg-tt-card p-4 backdrop-blur-xl">
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold">Auction</span>
            <span className="text-[13px] text-tt-muted">
              {auctionRunning
                ? `Running · $${currentBid.toFixed(2)}${currentWinner ? ` · ${currentWinner}` : ''}`
                : 'Idle'}
            </span>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => send({ action: 'startAuction' })}
              disabled={!connected || auctionRunning}
              className="flex min-h-[44px] cursor-pointer items-center justify-center rounded-xl bg-[#00B66C] px-4 text-[15px] font-semibold text-white transition-[filter] duration-200 hover:brightness-110 active:brightness-95 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            >
              Start auction
            </button>
            <button
              type="button"
              onClick={() => send({ action: 'resetAuction' })}
              disabled={!connected}
              className="flex min-h-[44px] cursor-pointer items-center justify-center rounded-xl border border-tt-border bg-tt-input-bg px-4 text-[15px] font-medium text-tt-text transition-colors duration-200 hover:bg-tt-card-hover disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/40"
            >
              Reset auction
            </button>
          </div>

          <button
            type="button"
            onClick={() => send({ action: 'placeBid', username: randomUsername() })}
            disabled={!connected || !auctionRunning}
            className="flex min-h-[48px] w-full cursor-pointer items-center justify-center rounded-xl bg-[#FE2C55] text-[16px] font-bold text-white transition-[filter] duration-200 hover:brightness-110 active:brightness-95 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          >
            Place bid (+$1)
          </button>
          {!auctionRunning && (
            <p className="text-[12px] text-tt-muted">Start an auction to place bids.</p>
          )}
        </section>

        {/* Comments */}
        <section className="space-y-3 rounded-2xl border border-tt-border bg-tt-card p-4 backdrop-blur-xl">
          <span className="text-sm font-semibold">Comments</span>

          <div className="flex gap-2">
            <input
              type="text"
              value={customText}
              onChange={(e) => setCustomText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCustomSend();
              }}
              aria-label="Custom comment"
              placeholder="Custom comment…"
              className="min-w-0 flex-1 rounded-lg border border-tt-input-border bg-tt-input-bg px-3 py-2.5 text-sm text-tt-text transition-colors focus:border-tt-cyan focus:outline-none"
            />
            <button
              type="button"
              onClick={handleCustomSend}
              disabled={!connected || !customText.trim()}
              className="flex min-h-[44px] shrink-0 cursor-pointer items-center justify-center rounded-lg bg-gradient-to-r from-tt-cyan to-[#4db8c0] px-5 text-sm font-semibold text-black transition-opacity duration-200 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/50"
            >
              Send
            </button>
          </div>

          <div className="flex flex-wrap gap-2">
            {COMMENTS.map((c) => (
              <button
                key={c}
                type="button"
                onClick={() => sendComment(c)}
                disabled={!connected}
                className="cursor-pointer rounded-full border border-tt-border bg-tt-input-bg px-3 py-2 text-[12px] text-tt-text transition-colors duration-200 hover:bg-tt-card-hover disabled:cursor-not-allowed disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-tt-cyan/40"
              >
                {c}
              </button>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
