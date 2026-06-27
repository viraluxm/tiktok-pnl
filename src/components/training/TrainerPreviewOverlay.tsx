'use client';

import type { LiveComment } from './simulatorData';

export interface PreviewAuction {
  phase: 'idle' | 'running' | 'ended';
  bid: number;
  seconds: number;
  winner: string | null;
  soldAt: number | null;
}

// Read-only mirror of the host Practice Live overlay, sized for the small
// controller video preview. Non-interactive (pointer-events-none): the trainer's
// real actions stay on the controls to the right. Same visual language as
// LiveOverlay (tt tokens, red live badge, purple timer pill, white auction card).
function Avatar({ name }: { name: string }) {
  return (
    <div className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-[#FE2C55] to-[#7C3AED] text-[8px] font-bold text-white">
      {name.charAt(0).toUpperCase()}
    </div>
  );
}

export default function TrainerPreviewOverlay({
  comments,
  auction,
}: {
  comments: LiveComment[];
  auction: PreviewAuction;
}) {
  const { phase, bid, seconds, winner, soldAt } = auction;

  return (
    <div className="pointer-events-none absolute inset-0 flex flex-col p-2">
      {/* LIVE badge */}
      <div>
        <span className="inline-flex items-center gap-1 rounded-full bg-[#FE2C55] px-1.5 py-0.5 text-[8px] font-bold uppercase text-white">
          <span className="h-1 w-1 rounded-full bg-white motion-safe:animate-pulse" />
          Live
        </span>
      </div>

      <div className="flex-1" />

      {/* Bottom: recent comments + auction card */}
      <div className="flex flex-col gap-1.5">
        <div className="flex max-w-[88%] flex-col gap-1">
          {comments.map((c) => (
            <div key={c.id} className="flex items-start gap-1">
              <Avatar name={c.username} />
              <div className="rounded-lg bg-black/40 px-1.5 py-0.5 backdrop-blur-sm">
                <span className="text-[9px] font-semibold text-white/70">{c.username}</span>{' '}
                <span className="text-[10px] text-white">{c.text}</span>
              </div>
            </div>
          ))}
        </div>

        {/* Auction card (read-only) */}
        <div className="flex min-h-[40px] w-full items-center rounded-xl bg-white px-2 py-1.5 shadow-lg shadow-black/25">
          {phase === 'idle' && (
            <div className="flex w-full items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[11px] font-semibold text-black">Mock auction</div>
                <div className="text-[9px] text-black/50">Ready when you are</div>
              </div>
              <span className="rounded-md bg-[#FE2C55] px-3 py-1 text-[11px] font-bold text-white">
                Start
              </span>
            </div>
          )}

          {phase === 'running' && (
            <div className="flex w-full items-center gap-2">
              <span className="shrink-0 rounded-full bg-gradient-to-br from-[#9A4DFF] to-[#6E29F0] px-1.5 py-0.5 text-[10px] font-bold text-white">
                {seconds}s
              </span>
              <span className="shrink-0 text-[15px] font-extrabold leading-none text-black">
                ${bid.toFixed(2)}
              </span>
              {winner ? (
                <span className="flex min-w-0 items-center gap-1">
                  <Avatar name={winner} />
                  <span className="truncate text-[10px] text-black">
                    <span className="font-semibold">{winner}</span> is winning.
                  </span>
                </span>
              ) : (
                <span className="truncate text-[10px] text-black/50">No bids yet</span>
              )}
            </div>
          )}

          {phase === 'ended' && (
            <div className="flex w-full items-center gap-2">
              <span className="shrink-0 rounded-full bg-[#00B66C] px-1.5 py-0.5 text-[10px] font-bold text-white">
                Sold
              </span>
              <span className="shrink-0 text-[15px] font-extrabold leading-none text-black">
                ${(soldAt ?? 0).toFixed(2)}
              </span>
              {winner && (
                <span className="truncate text-[10px] text-black">
                  <span className="font-semibold">{winner}</span> won
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
