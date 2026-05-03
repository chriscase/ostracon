'use client';

import { useEffect, useState } from 'react';
import { useCodexGraphqlRequest } from './CodexAdapters';
import styles from './codex.module.css';

const SEARCH_QUERY = `
  query VaultSearch($query: String!, $limit: Int) {
    vaultSearch(query: $query, limit: $limit) {
      score
      matchedOn
      excerpt
      note {
        path
        title
        folder
        status
        isAutoManaged
      }
    }
  }
`;

export interface CodexSearchHit {
  score: number;
  matchedOn: 'title' | 'tag' | 'path' | 'body';
  excerpt?: string | null;
  note: {
    path: string;
    title: string;
    folder: string;
    status?: string | null;
    isAutoManaged: boolean;
  };
}

interface Props {
  onResults: (hits: CodexSearchHit[] | null) => void;
}

const DEBOUNCE_MS = 200;

export default function CodexSearch({ onResults }: Props) {
  const [query, setQuery] = useState('');
  const graphqlRequest = useCodexGraphqlRequest();

  useEffect(() => {
    const trimmed = query.trim();
    if (!trimmed) {
      onResults(null);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const { data, errors } = await graphqlRequest<{ vaultSearch: CodexSearchHit[] }>(
          SEARCH_QUERY,
          { query: trimmed, limit: 30 },
        );
        if (cancelled) return;
        if (errors?.length) {
          onResults([]);
          return;
        }
        onResults(data?.vaultSearch ?? []);
      } catch {
        if (!cancelled) onResults([]);
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
    // onResults is stable from parent; avoid re-running on identity change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, graphqlRequest, onResults]);

  return (
    <div className={styles.searchWrap}>
      <input
        type="search"
        className={styles.searchInput}
        placeholder="Search vault…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        aria-label="Search vault"
      />
      {query && (
        <button
          type="button"
          className={styles.searchClear}
          onClick={() => setQuery('')}
          aria-label="Clear search"
        >
          ✕
        </button>
      )}
    </div>
  );
}
