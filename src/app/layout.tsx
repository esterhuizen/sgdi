import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono, Manrope } from 'next/font/google';
import './globals.css';

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? 'https://gdindex.app';

// Self-hosted via next/font — no third-party CSS request at runtime.
// Three faces:
//   Inter      — body / UI text
//   Manrope    — display headings (slightly more editorial than Inter)
//   JetBrains  — every numeric (.num class) for that "real data" feel
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
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-mono',
  display: 'swap',
});

export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0d12' },
  ],
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

// No-flash theme script. Inlined into <head> so it runs *before* any
// React render, eliminating the white→dark flash on first paint. Reads
// the user's stored choice, falls back to system preference. Plain JS —
// no React, no imports.
const themeInitScript = `
(function() {
  try {
    var stored = localStorage.getItem('theme');
    var theme = stored
      ? stored
      : (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    if (theme === 'dark') document.documentElement.classList.add('dark');
    document.documentElement.dataset.theme = theme;
  } catch (e) {}
})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${inter.variable} ${manrope.variable} ${jetbrainsMono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="min-h-screen bg-bg text-ink antialiased transition-colors">
        {children}
      </body>
    </html>
  );
}
