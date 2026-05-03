'use client';

// Cmd+P quick-open (chriscase/abydonian#219).
//
// Fuzzy-search the vault index by note title or path. Selecting a hit
// navigates to the note. Powered by the existing vaultSearch GraphQL query
// (also used by the sidebar search bar) — same scoring, same matchedOn
// labels.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useCodexGraphqlRequest, useCodexNavigation } from './CodexAdapters';
import { noteHref } from './CodexTree';
import styles from './codex.module.css';

const SEARCH_QUERY = `
  query QuickSearch($query: String!, $limit: Int) {
    vaultSearch(query: $query, limit: $limit) {
      note {
        path
        title
        folder
      }
      score
      matchedOn
    }
  }
`;

interface SearchHit {
  note: { path: string; title: string; folder: string };
  score: number;
  matchedOn: 'title' | 'tag' | 'path' | 'body';
}

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function QuickOpen({ open, onClose }: Props) {
  const graphqlRequest = useCodexGraphqlRequest();
  const { useRouter: useNavRouter } = useCodexNavigation();
  const router = useNavRouter();
  const [query, setQuery] = useState<string>('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset on open.
  useEffect(() => {
    if (open) {
      setQuery('');
      setHits([]);
      setActiveIndex(0);
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // Debounced search.
  useEffect(() => {
    if (!open) return;
    if (!query.trim()) {
      setHits([]);
      return;
    }
    let cancelled = false;
    const handle = setTimeout(async () => {
      setLoading(true);
      try {
        const { data } = await graphqlRequest<{ vaultSearch: SearchHit[] }>(
          SEARCH_QUERY,
          { query, limit: 30 },
        );
        if (cancelled) return;
        setHits(data?.vaultSearch ?? []);
        setActiveIndex(0);
      } catch {
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [query, open]);

  const ordered = useMemo(() => {
    // Prioritize title hits over body/path/tag, score descending within each.
    const rank: Record<string, number> = { title: 0, tag: 1, path: 2, body: 3 };
    return [...hits].sort((a, b) => {
      const r = (rank[a.matchedOn] ?? 9) - (rank[b.matchedOn] ?? 9);
      if (r !== 0) return r;
      return b.score - a.score;
    });
  }, [hits]);

  if (!open) return null;

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, ordered.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const hit = ordered[activeIndex];
      if (hit) {
        onClose();
        router.push(noteHref(hit.note.path));
      }
    }
  }

  return (
    <div className={styles.modalBackdrop} onClick={onClose} role="presentation">
      <div
        className={styles.palette}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <input
          ref={inputRef}
          type="text"
          className={styles.paletteInput}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search notes by title…"
          spellCheck={false}
          data-allow-text="true"
        />
        <ul className={styles.paletteList} role="listbox">
          {!query.trim() ? (
            <li className={styles.paletteEmpty}>Start typing to search the vault</li>
          ) : loading && ordered.length === 0 ? (
            <li className={styles.paletteEmpty}>Searching…</li>
          ) : ordered.length === 0 ? (
            <li className={styles.paletteEmpty}>No matches</li>
          ) : (
            ordered.map((hit, idx) => (
              <li
                key={hit.note.path}
                className={`${styles.paletteItem} ${idx === activeIndex ? styles.paletteItemActive : ''}`}
                role="option"
                aria-selected={idx === activeIndex}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => {
                  onClose();
                  router.push(noteHref(hit.note.path));
                }}
              >
                <span className={styles.paletteCategory}>{hit.matchedOn}</span>
                <span>{hit.note.title}</span>
                <span className={styles.paletteHint}>{hit.note.folder}</span>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
