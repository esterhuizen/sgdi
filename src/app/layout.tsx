import type { Metadata, Viewport } from 'next';
import { Inter, Manrope } from 'next/font/google';
import './globals.css';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://sgdi.app';

// Self-hosted via next/font — no third-party CSS request at runtime.
const inter = Inter({
  subsets: ['latin'],
  variable: '--font-sans',
  display: 'swap',
});
const manrope = Manrope({
  subsets: ['latin'],
  weight: ['500', '600', '700', '800'],
  variable: '--font-display',
  display: 'swap',
});

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
    'Per-epoch leaderboard ranking Solana stake pools by stake-weighted geographic decentralisation. Pick a pool above the network baseline to earn the same yield while strengthening the network.',
  applicationName: 'SGDI',
  keywords: [
    'Solana',
    'stake pool',
    'decentralisation',
    'liquid staking',
    'LST',
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
    card: 'summary_large_image',
    title: 'SGDI — Solana Geographic Decentralisation Index',
    description: 'Open leaderboard of Solana stake pools by geographic decentralisation.',
  },
  robots: { index: true, follow: true },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${manrope.variable}`}
    >
      <body className="min-h-screen bg-bg text-ink antialiased">{children}</body>
    </html>
  );
}
