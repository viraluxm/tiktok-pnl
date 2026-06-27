'use client';

import { useState } from 'react';
import type { LiveComment } from './simulatorData';

interface AuctionView {
  phase: 'idle' | 'running' | 'ended';
  bid: number;
  seconds: number;
  winner: string | null;
  soldAt: number | null;
}

interface LiveOverlayProps {
  hostName: string;
  viewers: number;
  sessionTimeLabel: string;
  comments: LiveComment[];
  auction: AuctionView;
  onStartAuction: () => void;
  onBlockUser: (comment: LiveComment) => void;
  toast: string | null;
}

const RED = '#FE2C55';

/* ---------- Icons (inline SVG, no emojis) ---------- */
type IconProps = { className?: string };

const lineProps = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

function IconHeart({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 21s-6.7-4.35-9.33-8.07C.9 10.36 1.6 6.9 4.6 5.7c1.94-.78 3.9-.1 5.4 1.6 1.5-1.7 3.46-2.38 5.4-1.6 3 1.2 3.7 4.66 1.93 7.23C18.7 16.65 12 21 12 21z" />
    </svg>
  );
}

function IconEye({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...lineProps} className={className} aria-hidden="true">
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}

function IconClock({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...lineProps} className={className} aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

function IconGavel({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...lineProps} className={className} aria-hidden="true">
      <path d="m14.5 12.5-8 8a2.119 2.119 0 1 1-3-3l8-8" />
      <path d="m16 16 6-6" />
      <path d="m8 8 6-6" />
      <path d="m9 7 8 8" />
      <path d="m21 11-8-8" />
    </svg>
  );
}

function IconCheck({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="M5 13l4 4L19 7" />
    </svg>
  );
}

function IconComment({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...lineProps} className={className} aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function IconShare({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...lineProps} className={className} aria-hidden="true">
      <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
      <path d="M16 6l-4-4-4 4" />
      <path d="M12 2v13" />
    </svg>
  );
}

function IconSparkles({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
    </svg>
  );
}

function IconUsers({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" {...lineProps} className={className} aria-hidden="true">
      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}

function IconMore({ className }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" className={className} aria-hidden="true">
      <circle cx="5" cy="12" r="1.6" />
      <circle cx="12" cy="12" r="1.6" />
      <circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}

/* ---------- Small building blocks ---------- */
function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#FE2C55] to-[#7C3AED] font-bold text-white ${className ?? ''}`}
      aria-hidden="true"
    >
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

function DecoIcon({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-9 w-9 items-center justify-center rounded-full bg-black/30 text-white backdrop-blur-md">
      {children}
    </div>
  );
}

function AuctionCard({ auction, onStartAuction }: { auction: AuctionView; onStartAuction: () => void }) {
  const { phase, bid, seconds, winner, soldAt } = auction;
  return (
    <div className="flex min-h-[68px] w-full items-center rounded-[18px] bg-white px-3.5 py-3 shadow-xl shadow-black/25">
      {phase === 'idle' && (
        <div className="flex w-full items-center justify-between gap-3">
          <div className="min-w-0">
            <div className="text-[14px] font-semibold text-black">Mock auction</div>
            <div className="text-[12px] text-black/50">Ready when you are</div>
          </div>
          <button
            type="button"
            onClick={onStartAuction}
            className="inline-flex min-h-[44px] cursor-pointer items-center justify-center rounded-xl px-7 text-[15px] font-bold text-white transition-[filter] duration-200 hover:brightness-110 active:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
            style={{ backgroundColor: RED }}
          >
            Start
          </button>
        </div>
      )}

      {phase === 'running' && (
        <div className="flex w-full items-center gap-3">
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-gradient-to-br from-[#9A4DFF] to-[#6E29F0] px-2.5 py-1 text-[13px] font-bold text-white">
            <IconGavel className="h-3.5 w-3.5" />
            {seconds}s
          </span>
          <span className="shrink-0 text-[22px] font-extrabold leading-none text-black">
            ${bid.toFixed(2)}
          </span>
          <span className="flex min-w-0 items-center gap-1.5">
            {winner && <Avatar name={winner} className="h-5 w-5 text-[10px]" />}
            <span className="truncate text-[13px] text-black">
              <span className="font-semibold">{winner}</span> is winning.
            </span>
          </span>
        </div>
      )}

      {phase === 'ended' && (
        <div className="flex w-full items-center gap-3">
          <span className="flex shrink-0 items-center gap-1 rounded-full bg-[#00B66C] px-2.5 py-1 text-[13px] font-bold text-white">
            <IconCheck className="h-3.5 w-3.5" />
            Sold
          </span>
          <span className="shrink-0 text-[22px] font-extrabold leading-none text-black">
            ${(soldAt ?? 0).toFixed(2)}
          </span>
          <span className="truncate text-[13px] text-black">
            <span className="font-semibold">{winner}</span> won
          </span>
        </div>
      )}
    </div>
  );
}

/* ---------- Overlay ---------- */
export default function LiveOverlay({
  hostName,
  viewers,
  sessionTimeLabel,
  comments,
  auction,
  onStartAuction,
  onBlockUser,
  toast,
}: LiveOverlayProps) {
  const [selected, setSelected] = useState<LiveComment | null>(null);

  const initials = hostName
    .split(' ')
    .slice(0, 2)
    .map((w) => w.charAt(0))
    .join('')
    .toUpperCase();

  return (
    <div
      className="absolute inset-0 z-10 flex flex-col"
      style={{
        paddingTop: 'calc(env(safe-area-inset-top) + 10px)',
        paddingBottom: 'calc(env(safe-area-inset-bottom) + 10px)',
        paddingLeft: 'calc(env(safe-area-inset-left) + 12px)',
        paddingRight: 'calc(env(safe-area-inset-right) + 12px)',
      }}
    >
      {/* Top bar */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 rounded-full bg-black/40 py-1 pl-1 pr-3 backdrop-blur-md">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-[#FE2C55] to-[#7C3AED] text-[11px] font-bold text-white">
            {initials}
          </div>
          <div className="flex flex-col leading-tight">
            <span className="max-w-[120px] truncate text-[13px] font-semibold text-white">{hostName}</span>
            <span className="flex items-center gap-1 text-[11px] text-white/75">
              <IconHeart className="h-3 w-3" />0
            </span>
          </div>
        </div>

        <div className="flex flex-col items-end gap-1.5">
          <div className="flex items-center gap-1.5">
            <span
              className="flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-bold uppercase text-white"
              style={{ backgroundColor: RED }}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-white motion-safe:animate-pulse" />
              Live
            </span>
            <span className="flex items-center gap-1 rounded-full bg-black/40 px-2 py-1 text-[12px] font-semibold text-white backdrop-blur-md">
              <IconEye className="h-3.5 w-3.5" />
              {viewers}
            </span>
          </div>
          <span className="flex items-center gap-1 rounded-full bg-black/40 px-2 py-1 text-[11px] font-medium text-white/85 backdrop-blur-md">
            <IconClock className="h-3 w-3" />
            {sessionTimeLabel}
          </span>
        </div>
      </div>

      {/* Camera shows through here */}
      <div className="flex-1" />

      {/* Bottom stack */}
      <div className="flex flex-col gap-3">
        {/* Comment feed (latest few) */}
        <div className="flex max-w-[82%] flex-col items-start gap-1.5">
          {comments.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setSelected(c)}
              aria-label={`Moderate comment from ${c.username}`}
              className="flex w-fit max-w-full cursor-pointer items-start gap-2 rounded-2xl text-left transition-opacity duration-150 active:opacity-70 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/60 motion-safe:animate-[fadeIn_0.3s_ease]"
            >
              <Avatar name={c.username} className="h-6 w-6 text-[11px]" />
              <div className="rounded-2xl bg-black/35 px-2.5 py-1.5 backdrop-blur-sm">
                <span className="text-[12px] font-semibold text-white/70">{c.username}</span>{' '}
                <span className="text-[13px] text-white">{c.text}</span>
              </div>
            </button>
          ))}
        </div>

        {/* Auction status card */}
        <AuctionCard auction={auction} onStartAuction={onStartAuction} />

        {/* Decorative host control row (inspired by the live UI) */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5" aria-hidden="true">
            <DecoIcon>
              <IconSparkles className="h-5 w-5" />
            </DecoIcon>
            <DecoIcon>
              <IconUsers className="h-5 w-5" />
            </DecoIcon>
          </div>
          <div className="flex items-center gap-2.5" aria-hidden="true">
            <DecoIcon>
              <IconComment className="h-5 w-5" />
            </DecoIcon>
            <DecoIcon>
              <IconShare className="h-5 w-5" />
            </DecoIcon>
            <DecoIcon>
              <IconMore className="h-5 w-5" />
            </DecoIcon>
          </div>
        </div>
      </div>

      {/* "User blocked" toast */}
      {toast && (
        <div className="pointer-events-none fixed left-1/2 top-[15%] z-30 -translate-x-1/2 rounded-full bg-black/75 px-4 py-2 text-[13px] font-medium text-white backdrop-blur-md motion-safe:animate-[fadeIn_0.2s_ease]">
          {toast}
        </div>
      )}

      {/* Comment moderation bottom sheet */}
      {selected && (
        <div className="fixed inset-0 z-30 flex flex-col justify-end">
          <button
            type="button"
            aria-label="Close"
            onClick={() => setSelected(null)}
            className="absolute inset-0 cursor-pointer bg-black/55 motion-safe:animate-[fadeIn_0.15s_ease]"
          />
          <div
            className="relative z-10 w-full rounded-t-3xl bg-[#1c1c1e] px-4 pt-2.5 motion-safe:animate-[fadeIn_0.2s_ease]"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom) + 12px)' }}
          >
            <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-white/25" />
            <div className="mb-4 flex items-start gap-2.5">
              <Avatar name={selected.username} className="h-9 w-9 text-[13px]" />
              <div className="min-w-0">
                <div className="text-[14px] font-semibold text-white">{selected.username}</div>
                <div className="truncate text-[13px] text-white/60">{selected.text}</div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                onBlockUser(selected);
                setSelected(null);
              }}
              className="mb-2 flex min-h-[50px] w-full cursor-pointer items-center justify-center rounded-xl text-[16px] font-semibold text-white transition-[filter] duration-200 hover:brightness-110 active:brightness-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
              style={{ backgroundColor: RED }}
            >
              Block user
            </button>
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="flex min-h-[50px] w-full cursor-pointer items-center justify-center rounded-xl bg-white/10 text-[16px] font-medium text-white transition-colors duration-200 hover:bg-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
