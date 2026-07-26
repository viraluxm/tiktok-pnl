import type { Metadata, Viewport } from 'next';
import Providers from '@/providers/Providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Lensed — TikTok Shop P&L Dashboard',
  description: 'Track your TikTok Shop profit and loss, manage products, and visualize performance with Lensed.',
  metadataBase: new URL('https://lensed.io'),
  openGraph: {
    title: 'Lensed — TikTok Shop P&L Dashboard',
    description: 'Track your TikTok Shop profit and loss, manage products, and visualize performance.',
    url: 'https://lensed.io',
    siteName: 'Lensed',
    type: 'website',
  },
};

// device-width is already Next's default; this adds viewport-fit=cover so
// env(safe-area-inset-*) resolves on notched phones, plus a matching theme color.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#0f0f0f',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
