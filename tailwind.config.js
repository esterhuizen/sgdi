/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{ts,tsx}'],
  // Class-based dark mode — toggled by <html class="dark"> which is set by
  // the no-flash inline script in layout.tsx (reads localStorage + system pref).
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        // Token values are CSS variables from globals.css. This means every
        // utility (bg-bg, text-ink, border-ring, etc.) renders correctly in
        // both light and dark with zero `dark:` modifier sprinkled in markup.
        ink: {
          DEFAULT: 'rgb(var(--color-ink) / <alpha-value>)',
          muted: 'rgb(var(--color-ink-muted) / <alpha-value>)',
          dim: 'rgb(var(--color-ink-dim) / <alpha-value>)',
        },
        bg: {
          DEFAULT: 'rgb(var(--color-bg) / <alpha-value>)',
          muted: 'rgb(var(--color-bg-muted) / <alpha-value>)',
          tint: 'rgb(var(--color-bg-tint) / <alpha-value>)',
        },
        surface: 'rgb(var(--color-surface) / <alpha-value>)',
        ring: 'rgb(var(--color-ring) / <alpha-value>)',
        accent: {
          green: 'rgb(var(--color-accent-green) / <alpha-value>)',
          purple: 'rgb(var(--color-accent-purple) / <alpha-value>)',
        },
        success: {
          DEFAULT: 'rgb(var(--color-success) / <alpha-value>)',
        },
        bad: {
          DEFAULT: 'rgb(var(--color-bad) / <alpha-value>)',
        },
      },
      fontFamily: {
        sans: ['var(--font-sans)', 'ui-sans-serif', 'system-ui', '-apple-system', 'sans-serif'],
        display: ['var(--font-display)', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['var(--font-mono)', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      letterSpacing: {
        tight2: '-0.025em',
      },
    },
  },
  plugins: [],
};
