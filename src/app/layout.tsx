import type { Metadata, Viewport } from 'next';
import './globals.css';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://sgdi.app';

export const viewport: Viewport = {
  themeColor: '#ffffff',
  width: 'device-width',
  initialScale: 1,
};

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: 'SGDI — Solana Geographic Decentralisation Index',
    template: '%s — SGDI',
  },
  description:
    'Per-epoch leaderboard ranking Solana stake pools by stake-weighted geographic decentralisation. Open methodology, reproducible from on-chain data.',
  applicationName: 'SGDI',
  keywords: [
    'Solana',
    'stake pool',
    'decentralisation',
    'GDI',
    'validator geography',
    'Nakamoto coefficient',
  ],
  openGraph: {
    title: 'SGDI — Solana Geographic Decentralisation Index',
    description:
      'Per-epoch leaderboard ranking Solana stake pools by stake-weighted geographic decentralisation.',
    url: SITE_URL,
    siteName: 'SGDI',
    type: 'website',
  },
  twitter: {
    card: 'summary',
    title: 'SGDI — Solana Geographic Decentralisation Index',
    description: 'Open leaderboard of Solana stake pools by geographic decentralisation.',
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-bg text-ink antialiased">
        {children}
      </body>
    </html>
  );
}
