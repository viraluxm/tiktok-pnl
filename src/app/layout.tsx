import type { Metadata } from 'next';
import Providers from '@/providers/Providers';
import './globals.css';

export const metadata: Metadata = {
  title: 'TikTok Shop P&L Calculator',
  description: 'Track your TikTok Shop profit and loss across multiple products',
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
