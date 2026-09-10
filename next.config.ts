import type { NextConfig } from "next";

// The LiveKit signalling WebSocket origin, formatted as a CSP source expression.
//
// WHY DERIVED AND NOT HARD-CODED. LiveKit here is SELF-HOSTED, so its host differs per
// environment (prod / preview / a local server). Reading NEXT_PUBLIC_LIVEKIT_URL —
// the same var the client already uses — keeps the header correct everywhere
// without a second place to update. next.config.ts is evaluated at build time,
// where all env vars are available.
//
// FAIL-OPEN TO TODAY'S HEADER. An unset or unparseable value returns "", leaving
// connect-src byte-identical to what ships now — so this can never break a deploy
// that has no LiveKit configured.
//
// ONLY ws:/wss: ARE ACCEPTED. Whitelisting the scheme means a malformed env value
// cannot inject an arbitrary source expression (or a whole extra directive) into
// the header.
//
// SUPABASE NEEDS NO ENTRY: CSP Level 3 lets an `https:` source expression match a
// `wss:` URL, so the existing `https://*.supabase.co` already covers Realtime.
// LiveKit is a different origin, which is why it needs its own.
function livekitConnectSrc(): string {
  const raw = process.env.NEXT_PUBLIC_LIVEKIT_URL?.trim();
  if (!raw) return "";
  try {
    const { protocol, host } = new URL(raw);
    if (protocol !== "wss:" && protocol !== "ws:") return "";
    return ` ${protocol}//${host}`;
  } catch {
    return "";
  }
}

const nextConfig: NextConfig = {
  // The Next.js dev-tools badge (the round "N") is DEV-ONLY and never renders in a production
  // build, but at bottom-left it sits inside the employee portal's bottom navigation and reads
  // like a fourth tab during review. Keep it available, out of the way.
  devIndicators: { position: 'top-left' },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            // camera=(self) and microphone=(self) allow getUserMedia on this
            // same-origin app only (needed by /admin/training/live-simulator so a
            // trainer can hear the practice host). Neither is delegated to any
            // third-party origin or iframe. geolocation stays disabled.
            key: "Permissions-Policy",
            value: "camera=(self), microphone=(self), geolocation=()",
          },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
          {
            key: "Content-Security-Policy-Report-Only",
            value:
              "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self' https://*.supabase.co https://*.tiktok.com https://*.tiktok-shops.com" +
              livekitConnectSrc() +
              ";",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
