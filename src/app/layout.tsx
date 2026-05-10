import type { Metadata, Viewport } from 'next';
import { Inter, Manrope } from 'next/font/google';
import './globals.css';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://gdindex.app';

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
    default: 'Solana Stake Pool Decentralisation Index',
    template: '%s — Solana Stake Pool Decentralisation Index',
  },
  description:
    'Every Solana stake pool ranked by how widely its stake is spread — country, city, and network operator of every validator, every epoch.',
  applicationName: 'Solana Stake Pool Decentralisation Index',
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
    title: 'Solana Stake Pool Decentralisation Index',
    description:
      'Every Solana stake pool ranked by how widely its stake is spread — country, city, and network operator of every validator, every epoch.',
    url: SITE_URL,
    siteName: 'Solana Stake Pool Decentralisation Index',
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Solana Stake Pool Decentralisation Index',
    description: 'Open leaderboard of Solana stake pools ranked by geographic decentralisation.',
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
