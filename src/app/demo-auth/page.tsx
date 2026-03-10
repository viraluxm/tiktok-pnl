"use client";

import { useEffect, useState } from "react";
import Image from "next/image";

type Phase = "connect" | "tiktok-auth" | "callback-loading" | "callback-success";

const TikTokLogo = ({ className, fill }: { className?: string; fill?: string }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none">
    <path
      d="M19.59 6.69a4.83 4.83 0 01-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 01-2.88 2.5 2.89 2.89 0 01-2.88-2.88 2.89 2.89 0 012.88-2.88c.28 0 .56.04.82.1v-3.5a6.37 6.37 0 00-.82-.05A6.34 6.34 0 003.15 15.2a6.34 6.34 0 006.34 6.34 6.34 6.34 0 006.34-6.34V8.7a8.18 8.18 0 004.76 1.52v-3.4a4.85 4.85 0 01-1-.13z"
      fill={fill || "currentColor"}
    />
  </svg>
);

/* ─── Phase 1: Lensed "Connect TikTok Shop" ─── */
function ConnectScreen({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="min-h-screen bg-[#0f0f0f] text-[#e8e8e8] animate-fade-in">
      {/* Nav mimicking the real Lensed nav */}
      <nav className="sticky top-0 z-50 bg-[#0a0a0a]/80 backdrop-blur-xl border-b border-white/[0.06]">
        <div className="max-w-7xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Image src="/logo.png" alt="Lensed" width={36} height={36} className="rounded-lg" />
            <span className="text-xl font-bold tracking-tight text-white">Lensed</span>
          </div>
          <div className="flex items-center gap-3">
            <div className="h-8 w-8 rounded-full bg-white/[0.08]" />
          </div>
        </div>
      </nav>

      <main className="flex flex-1 items-center justify-center px-4 py-24">
        <div className="w-full max-w-lg space-y-8 text-center">
          <div className="rounded-2xl border border-white/[0.08] bg-white/[0.03] p-8 shadow-lg">
            <div className="space-y-6">
              {/* TikTok Shop icon */}
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-white/[0.06] border border-white/[0.08]">
                <TikTokLogo className="h-8 w-8" fill="#e8e8e8" />
              </div>

              <div className="space-y-2">
                <h2 className="text-xl font-bold text-white">
                  Connect Your TikTok Shop
                </h2>
                <p className="text-sm text-[#888] leading-relaxed">
                  Link your TikTok Shop to Lensed to track your P&L,
                  manage products, and see your real profit numbers.
                </p>
              </div>

              {/* Features list */}
              <div className="space-y-3 text-left">
                {[
                  "Automatic order & revenue sync",
                  "Real-time P&L tracking per product",
                  "AI-powered sales forecasting",
                ].map((feature) => (
                  <div key={feature} className="flex items-center gap-3">
                    <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-[#69C9D0]/10">
                      <svg
                        className="h-3 w-3 text-[#69C9D0]"
                        fill="none"
                        viewBox="0 0 24 24"
                        strokeWidth={3}
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M4.5 12.75l6 6 9-13.5"
                        />
                      </svg>
                    </div>
                    <span className="text-sm text-[#e8e8e8]">{feature}</span>
                  </div>
                ))}
              </div>

              {/* Connect button */}
              <button
                onClick={onConnect}
                className="w-full rounded-xl bg-white px-6 py-3 text-sm font-semibold text-black transition-all hover:bg-gray-200 active:scale-[0.98] shadow-lg shadow-white/10"
              >
                <span className="flex items-center justify-center gap-2">
                  <TikTokLogo className="h-5 w-5" fill="#000" />
                  Connect TikTok Shop
                </span>
              </button>
            </div>
          </div>

          <p className="text-xs text-[#888]">
            You&apos;ll be redirected to TikTok to authorize access to your shop
          </p>
        </div>
      </main>
    </div>
  );
}

/* ─── Phase 2: Simulated TikTok OAuth authorization screen ─── */
function TikTokAuthScreen({ onAuthorize }: { onAuthorize: () => void }) {
  const permissions = [
    { label: "Shop Management", desc: "View and manage your shop profile and settings" },
    { label: "Product Management", desc: "Access and manage your product catalog" },
    { label: "Order Management", desc: "View order details and fulfillment status" },
    { label: "Sales Data", desc: "Access sales analytics and performance metrics" },
  ];

  return (
    <div className="min-h-screen flex flex-col bg-white animate-fade-in">
      {/* TikTok-style top bar */}
      <header className="border-b border-gray-200 bg-white px-6 py-3">
        <div className="mx-auto flex max-w-xl items-center gap-3">
          <TikTokLogo className="h-7 w-7" fill="#000" />
          <span className="text-lg font-semibold text-gray-900">TikTok Shop</span>
          <span className="text-sm text-gray-400">|</span>
          <span className="text-sm text-gray-500">Partner Authorization</span>
        </div>
      </header>

      <main className="flex flex-1 items-center justify-center px-4 bg-gray-50">
        <div className="w-full max-w-md space-y-6">
          <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
            {/* App info */}
            <div className="flex items-center gap-4 pb-5 border-b border-gray-100">
              <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-[#69C9D0] to-[#4F46E5] shadow-md">
                <span className="text-lg font-bold text-white">L</span>
              </div>
              <div>
                <h2 className="text-base font-semibold text-gray-900">Lensed</h2>
                <p className="text-xs text-gray-500">wants to access your TikTok Shop</p>
              </div>
            </div>

            {/* Permissions */}
            <div className="py-5 space-y-1">
              <p className="text-xs font-medium uppercase tracking-wider text-gray-400 mb-3">
                This application will be able to:
              </p>
              {permissions.map((perm) => (
                <div key={perm.label} className="flex items-start gap-3 py-2.5">
                  <svg
                    className="mt-0.5 h-4 w-4 shrink-0 text-[#00B578]"
                    fill="none"
                    viewBox="0 0 24 24"
                    strokeWidth={2.5}
                    stroke="currentColor"
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
                    />
                  </svg>
                  <div>
                    <p className="text-sm font-medium text-gray-800">{perm.label}</p>
                    <p className="text-xs text-gray-500">{perm.desc}</p>
                  </div>
                </div>
              ))}
            </div>

            {/* Account info */}
            <div className="flex items-center gap-3 rounded-lg bg-gray-50 px-4 py-3 mb-5 border border-gray-100">
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-gray-200">
                <svg className="h-4 w-4 text-gray-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M15.75 6a3.75 3.75 0 11-7.5 0 3.75 3.75 0 017.5 0zM4.501 20.118a7.5 7.5 0 0114.998 0A17.933 17.933 0 0112 21.75c-2.676 0-5.216-.584-7.499-1.632z" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-medium text-gray-800">My TikTok Shop</p>
                <p className="text-xs text-gray-500">Shop ID: 7849••••2031</p>
              </div>
            </div>

            {/* Action buttons */}
            <div className="space-y-3">
              <button
                onClick={onAuthorize}
                className="w-full rounded-lg bg-[#FE2C55] px-6 py-3 text-sm font-semibold text-white transition-all hover:bg-[#e0264c] active:scale-[0.98]"
              >
                Authorize
              </button>
              <button className="w-full rounded-lg border border-gray-200 bg-white px-6 py-3 text-sm font-medium text-gray-600 transition-all hover:bg-gray-50">
                Cancel
              </button>
            </div>
          </div>

          <p className="text-center text-xs text-gray-400">
            By authorizing, you agree to share the above data with Lensed.
            You can revoke access at any time from your TikTok Shop settings.
          </p>
        </div>
      </main>
    </div>
  );
}

/* ─── Phase 3 & 4: Callback loading → success ─── */
function CallbackScreen({ phase }: { phase: "callback-loading" | "callback-success" }) {
  return (
    <div className="min-h-screen flex items-center justify-center px-4 bg-[#0f0f0f]">
      <div className="w-full max-w-md text-center">
        {phase === "callback-loading" && (
          <div className="animate-fade-in space-y-6">
            <div className="mx-auto h-16 w-16 animate-spin rounded-full border-4 border-white/[0.08] border-t-[#69C9D0]" />
            <div className="space-y-2">
              <h1 className="text-xl font-semibold text-white">
                Connecting to TikTok...
              </h1>
              <p className="text-sm text-[#888]">
                Authorizing your TikTok Shop account
              </p>
            </div>
          </div>
        )}

        {phase === "callback-success" && (
          <div className="animate-fade-in space-y-6">
            {/* Green checkmark */}
            <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full bg-[#00c853]/10 ring-2 ring-[#00c853]/30">
              <svg
                className="h-10 w-10 text-[#00c853]"
                fill="none"
                viewBox="0 0 24 24"
                strokeWidth={2.5}
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4.5 12.75l6 6 9-13.5"
                  className="check-draw"
                />
              </svg>
            </div>

            <div className="space-y-3">
              <h1 className="text-2xl font-bold text-white">
                TikTok Shop Connected Successfully
              </h1>
              <div className="inline-flex items-center gap-2 rounded-lg bg-white/[0.05] px-4 py-2.5 border border-white/[0.08]">
                <TikTokLogo className="h-5 w-5" fill="#e8e8e8" />
                <span className="text-sm font-medium text-[#e8e8e8]">
                  My TikTok Shop
                </span>
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-sm text-[#00c853] font-medium">
                You&apos;re all set! Redirecting to your dashboard...
              </p>
              <div className="mx-auto h-1 w-32 overflow-hidden rounded-full bg-white/[0.08]">
                <div className="h-full progress-bar rounded-full bg-[#69C9D0]" />
              </div>
            </div>
          </div>
        )}
      </div>

      <style jsx>{`
        .check-draw {
          stroke-dasharray: 30;
          stroke-dashoffset: 30;
          animation: draw-check 0.5s ease-out forwards;
        }
        @keyframes draw-check {
          to { stroke-dashoffset: 0; }
        }
        .progress-bar {
          animation: fill-bar 2.8s ease-in-out forwards;
        }
        @keyframes fill-bar {
          from { width: 0%; }
          to { width: 100%; }
        }
      `}</style>
    </div>
  );
}

/* ─── Main orchestrator ─── */
export default function DemoAuthPage() {
  const [phase, setPhase] = useState<Phase>("connect");

  useEffect(() => {
    if (phase === "callback-loading") {
      const timer = setTimeout(() => setPhase("callback-success"), 1800);
      return () => clearTimeout(timer);
    }
  }, [phase]);

  useEffect(() => {
    if (phase === "callback-success") {
      const timer = setTimeout(() => {
        window.location.href = "/dashboard";
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [phase]);

  return (
    <>
      {phase === "connect" && (
        <ConnectScreen onConnect={() => setPhase("tiktok-auth")} />
      )}
      {phase === "tiktok-auth" && (
        <TikTokAuthScreen onAuthorize={() => setPhase("callback-loading")} />
      )}
      {(phase === "callback-loading" || phase === "callback-success") && (
        <CallbackScreen phase={phase} />
      )}
    </>
  );
}
