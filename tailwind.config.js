/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      // Academic / data-visualisation palette — calm, neutral, light by default.
      // Solana brand greens / purples used sparingly for accent only.
      colors: {
        ink: {
          DEFAULT: '#0d1014',
          muted: '#52566a',
          dim: '#8a8e9e',
        },
        bg: {
          DEFAULT: '#ffffff',
          muted: '#f7f7f9',
        },
        ring: '#ecedf3',
        accent: {
          // Solana brand colors — used as accent only, not primary surfaces.
          green: '#14F195',
          purple: '#9945FF',
        },
        success: '#22a36c',
        warn: '#c87a00',
        bad: '#c2364a',
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontFeatureSettings: {
        tabular: '"tnum"',
      },
    },
  },
  plugins: [],
};
