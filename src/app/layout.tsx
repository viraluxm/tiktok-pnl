import type { Metadata } from 'next';
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
