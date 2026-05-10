/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Academic / data-visualisation palette — calm, neutral, light.
        // Solana brand greens / purples used sparingly for accent only.
        ink: {
          DEFAULT: '#0d1014',
          muted: '#52566a',
          dim: '#8a8e9e',
        },
        bg: {
          DEFAULT: '#ffffff',
          muted: '#f7f7f9',
          tint: '#fafbff',
        },
        ring: '#ecedf3',
        accent: {
          green: '#14F195',
          purple: '#9945FF',
        },
        // Above/below baseline colouring — used on GDI cells in the leaderboard.
        success: {
          DEFAULT: '#22a36c',
          tint: '#e8f7f0',
        },
        warn: '#c87a00',
        bad: {
          DEFAULT: '#c2364a',
          tint: '#fbe9ec',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['var(--font-display)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      letterSpacing: {
        tight2: '-0.025em',
      },
    },
  },
  plugins: [],
};
