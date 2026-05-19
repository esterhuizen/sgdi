'use client';

import { useState, useMemo, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';

// Live-typeahead validator search. As the user types, the top N matches
// render as a dropdown beneath the input. Selecting one (click, Enter, or
// arrow-keys-then-Enter) navigates to that validator's detail page.
//
// Match ranking (higher = surfaced first):
//   1000 exact vote pubkey
//    999 exact identity pubkey
//    100 prefix match on name / vote / identity
//     10 substring match on name / vote / identity
//
// Empty input → no dropdown. No matches → inline "not found" only after the
// user attempts to submit (so we don't flash an error on every keystroke).

type SearchEntry = {
  vote: string;
  identity: string | null;
  name: string | null;
};

const MAX_RESULTS = 8;

function rankEntry(e: SearchEntry, lc: string): number {
  if (!lc) return -1;
  if (e.vote === lc) return 1000;
  if (e.identity === lc) return 999;
  const fields = [e.name?.toLowerCase(), e.vote.toLowerCase(), e.identity?.toLowerCase()];
  let best = -1;
  for (const f of fields) {
    if (!f) continue;
    if (f.startsWith(lc)) best = Math.max(best, 100);
    else if (f.includes(lc)) best = Math.max(best, 10);
  }
  return best;
}

function truncAddr(a: string): string {
  return `${a.slice(0, 8)}…${a.slice(-4)}`;
}

export function ValidatorSearchBox({ entries }: { entries: SearchEntry[] }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);             // highlighted index in dropdown
  const [error, setError] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);

  const matches = useMemo(() => {
    const lc = q.trim().toLowerCase();
    if (!lc) return [];
    return entries
      .map((e) => ({ e, score: rankEntry(e, lc) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_RESULTS)
      .map((x) => x.e);
  }, [entries, q]);

  // Keep highlight in range when the result set shrinks (e.g. user typed
  // an extra character and the previously-highlighted item dropped off).
  useEffect(() => {
    if (hi >= matches.length) setHi(0);
  }, [matches.length, hi]);

  function navigate(vote: string) {
    setError(null);
    router.push(`/validator/${vote}`);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (matches.length > 0) {
      const pick = matches[hi] ?? matches[0];
      navigate(pick.vote);
      return;
    }
    setError(
      `No active validator matched "${q.trim()}". Check the vote / identity ` +
      `pubkey or name (active set = currently voting, non-delinquent, stake > 0).`,
    );
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setQ(''); setError(null); return;
    }
    if (matches.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHi((i) => (i + 1) % matches.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHi((i) => (i - 1 + matches.length) % matches.length);
    }
  }

  // Show dropdown only when focused AND we have something to show.
  const showDropdown = focused && matches.length > 0;

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-[14px] h-4 w-4 text-ink-dim" />
        <input
          type="text"
          value={q}
          onChange={(e) => { setQ(e.target.value); setHi(0); setError(null); }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          // Delay blur so click on a result still fires before the
          // dropdown hides (mousedown→focus-leaves→click).
          onBlur={() => setTimeout(() => setFocused(false), 120)}
          placeholder="Vote account, identity key, or validator name"
          className="w-full rounded-lg border border-ring bg-surface px-10 py-3 text-sm text-ink placeholder:text-ink-dim focus:border-ink focus:outline-none"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          autoComplete="off"
          role="combobox"
          aria-expanded={showDropdown}
          aria-autocomplete="list"
          aria-controls="validator-search-results"
          aria-activedescendant={showDropdown ? `validator-search-result-${hi}` : undefined}
        />
        {showDropdown && (
          <ul
            id="validator-search-results"
            role="listbox"
            className="absolute left-0 right-0 top-full z-10 mt-1 max-h-72 overflow-y-auto rounded-lg border border-ring bg-surface shadow-lg"
          >
            {matches.map((m, i) => (
              <li
                key={m.vote}
                id={`validator-search-result-${i}`}
                role="option"
                aria-selected={i === hi}
              >
                <button
                  type="button"
                  onClick={() => navigate(m.vote)}
                  onMouseEnter={() => setHi(i)}
                  className={
                    'block w-full border-b border-ring px-3 py-2.5 text-left text-sm transition last:border-b-0 ' +
                    (i === hi ? 'bg-bg-muted/60' : 'hover:bg-bg-muted/30')
                  }
                >
                  <div className="font-medium text-ink">
                    {m.name || <span className="font-mono text-xs">{truncAddr(m.vote)}</span>}
                  </div>
                  <div className="mt-0.5 font-mono text-xs text-ink-dim">
                    {truncAddr(m.vote)}
                    {m.identity && (
                      <span className="ml-2 text-ink-dim">· id {truncAddr(m.identity)}</span>
                    )}
                  </div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <button
        type="submit"
        className="rounded-full border border-ink bg-ink px-4 py-2 text-sm text-bg transition-opacity hover:opacity-90"
      >
        Look up validator →
      </button>
      {error && (
        <p className="text-sm text-bad" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
