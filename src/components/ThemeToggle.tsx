'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';

// Theme toggle. Source of truth lives on <html class="dark"> (set initially
// by the no-flash script in layout.tsx). This component is a thin UI on top
// of that DOM state — toggling the class and persisting to localStorage.
//
// We deliberately don't try to be clever about "system" vs explicit user
// choice; a single click flips, period. If you cleared storage, the no-flash
// script picks system preference again on next page load.

export function ThemeToggle({ className = '' }: { className?: string }) {
  const [mounted, setMounted] = useState(false);
  const [isDark, setIsDark] = useState(false);

  useEffect(() => {
    setIsDark(document.documentElement.classList.contains('dark'));
    setMounted(true);
  }, []);

  function toggle() {
    const next = !isDark;
    document.documentElement.classList.toggle('dark', next);
    document.documentElement.dataset.theme = next ? 'dark' : 'light';
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light');
    } catch {
      // localStorage disabled — toggle still works for the session.
    }
    setIsDark(next);
  }

  // Pre-mount: render a same-size placeholder so the layout doesn't shift
  // and the icon doesn't briefly flash wrong.
  if (!mounted) {
    return (
      <button
        aria-label="Toggle theme"
        aria-hidden="true"
        className={`inline-flex h-9 w-9 items-center justify-center rounded-full border border-ring bg-bg ${className}`}
        suppressHydrationWarning
      />
    );
  }

  return (
    <button
      onClick={toggle}
      aria-label={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      title={isDark ? 'Switch to light theme' : 'Switch to dark theme'}
      className={`inline-flex h-9 w-9 items-center justify-center rounded-full border border-ring bg-bg text-ink-muted transition-colors hover:border-ink hover:text-ink ${className}`}
    >
      {isDark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
