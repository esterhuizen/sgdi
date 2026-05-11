'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Search } from 'lucide-react';

// Resolves a user-typed string (vote pubkey, identity pubkey, or a substring
// of either) to a validator detail page. The lookup table is the
// validator-index.json passed in as `searchMap` — a flat array of
// { vote, identity, name }. Match priority:
//   1. Exact vote pubkey
//   2. Exact identity pubkey
//   3. Case-insensitive substring of vote / identity / name
//
// On no match: shows an inline "not found" with a few suggestions.

type SearchEntry = {
  vote: string;
  identity: string | null;
  name: string | null;
};

export function ValidatorSearchBox({ entries }: { entries: SearchEntry[] }) {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const needle = q.trim();
    setError(null);
    if (!needle) return;

    // 1. exact vote pubkey
    let hit = entries.find((e) => e.vote === needle);
    // 2. exact identity pubkey
    if (!hit) hit = entries.find((e) => e.identity === needle);
    // 3. case-insensitive substring (vote / identity / name)
    if (!hit) {
      const lc = needle.toLowerCase();
      hit = entries.find(
        (e) =>
          e.vote.toLowerCase().includes(lc) ||
          (e.identity?.toLowerCase().includes(lc) ?? false) ||
          (e.name?.toLowerCase().includes(lc) ?? false),
      );
    }

    if (!hit) {
      setError(`No active validator matched "${needle}". Check the vote / identity pubkey is correct and that the validator is currently voting (not delinquent).`);
      return;
    }
    router.push(`/validator/${hit.vote}`);
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-dim" />
        <input
          type="text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Vote account, identity key, or validator name"
          className="w-full rounded-lg border border-ring bg-surface px-10 py-3 text-sm text-ink placeholder:text-ink-dim focus:border-ink focus:outline-none"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
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
