'use client';

// Cmd-K / Ctrl-K search palette.
//
// Centered overlay on desktop (>= 640px), full-height bottom sheet on
// mobile. Queries vaultSearch with mode='fulltext' so the host's tsvector
// (or any SearchAdapter implementation) returns ranked hits with
// highlighted excerpts. Keyboard-first: arrows + Enter, Esc to dismiss.
//
// Open it via the exported `<SearchPaletteTrigger />` button or by
// dispatching the `ostracon:open-search-palette` custom event. The
// palette itself listens for Cmd-K / Ctrl-K globally; consuming hosts
// can ignore the hotkey if they wire conflicting bindings.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useCodexGraphqlRequest, useCodexNavigation } from './CodexAdapters';
import styles from './codex.module.css';

// ─── GraphQL query ──────────────────────────────────────────────────────────

const PALETTE_SEARCH_QUERY = `
  query VaultSearchPalette(
    $query: String!
    $limit: Int
    $mode: CodexSearchMode
    $folder: String
    $tags: [String!]
  ) {
    vaultSearch(query: $query, limit: $limit, mode: $mode, folder: $folder, tags: $tags) {
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

interface Hit {
  score: number;
  matchedOn: 'title' | 'tag' | 'path' | 'body' | 'alias' | 'semantic';
  excerpt?: string | null;
  note: {
    path: string;
    title: string;
    folder: string;
    status?: string | null;
    isAutoManaged: boolean;
  };
}

type Mode = 'hybrid' | 'semantic' | 'fulltext' | 'substring' | 'tags';

const ALL_MODES: Array<{ id: Mode; label: string; hint: string; requiresSemantic?: boolean }> = [
  { id: 'hybrid', label: 'Hybrid', hint: 'Keyword + meaning combined' },
  { id: 'semantic', label: 'Semantic', hint: 'Find by meaning', requiresSemantic: true },
  { id: 'fulltext', label: 'Full-text', hint: 'tsvector ranking' },
  { id: 'substring', label: 'Substring', hint: 'Plain ILIKE / contains' },
  { id: 'tags', label: 'Tags', hint: 'Match notes carrying a tag' },
];

// Map UI mode to the server's CodexSearchMode arg. 'tags' is a UI-level
// shortcut: we pass the query into the `tags` filter and use the
// substring mode on top of that filter.
function serverModeFor(mode: Mode): { mode: string; useTagsFilter: boolean } {
  switch (mode) {
    case 'tags':
      return { mode: 'substring', useTagsFilter: true };
    default:
      return { mode, useTagsFilter: false };
  }
}

const DEBOUNCE_MS = 200;
const RECENT_KEY = 'ostracon-search-palette-recent';
const RECENT_CAP = 6;

function loadRecents(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === 'string').slice(0, RECENT_CAP);
  } catch {
    return [];
  }
}

function saveRecent(query: string) {
  if (typeof window === 'undefined') return;
  if (!query.trim()) return;
  const list = loadRecents().filter((s) => s !== query);
  list.unshift(query);
  try {
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, RECENT_CAP)));
  } catch {
    /* quota / private-mode — ignore */
  }
}

// ─── Trigger button + hotkey ─────────────────────────────────────────────────

const OPEN_EVENT = 'ostracon:open-search-palette';

/** Dispatch from anywhere in the host app to open the palette. The
 *  palette listens for this event globally. */
export function openSearchPalette() {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent(OPEN_EVENT));
}

/** Small button hosts can drop into their chrome to surface the palette
 *  on touch. The hotkey works regardless. */
export function SearchPaletteTrigger({ className }: { className?: string }) {
  return (
    <button
      type="button"
      className={className ?? styles.paletteTriggerButton}
      onClick={() => openSearchPalette()}
      aria-label="Search the vault"
      title="Search"
    >
      <span className={styles.paletteTriggerIcon} aria-hidden="true">⌕</span>
      <span className={styles.paletteTriggerLabel}>Search</span>
    </button>
  );
}

// ─── Palette ─────────────────────────────────────────────────────────────────

export interface SearchPaletteProps {
  /** Render path for hit results. Defaults to `/admin/codex/note/<path>` —
   *  override if the host mounts codex routes elsewhere. */
  noteHref?: (path: string) => string;
  /** When true, expose the Semantic mode chip. When false (default), the
   *  Semantic chip is hidden — but Hybrid stays visible because the host
   *  can still rank tsvector hits even without an embedding backend. */
  semanticEnabled?: boolean;
}

export function SearchPalette({ noteHref, semanticEnabled = false }: SearchPaletteProps) {
  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [query, setQuery] = useState('');
  const [mode, setMode] = useState<Mode>('hybrid');
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const [recents, setRecents] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const graphqlRequest = useCodexGraphqlRequest();
  const { useRouter } = useCodexNavigation();
  const router = useRouter();

  const hrefFor = useMemo(
    () =>
      noteHref ??
      ((p: string) =>
        '/admin/codex/note/' +
        p
          .replace(/\.md$/i, '')
          .split(/[\\/]/g)
          .map((seg) => encodeURIComponent(seg))
          .join('/')),
    [noteHref],
  );

  const visibleModes = useMemo(
    () => ALL_MODES.filter((m) => !m.requiresSemantic || semanticEnabled),
    [semanticEnabled],
  );

  // Mount portal once (avoid SSR mismatch).
  useEffect(() => {
    setMounted(true);
  }, []);

  // Refresh recents when palette opens.
  useEffect(() => {
    if (open) setRecents(loadRecents());
  }, [open]);

  // Open via custom event from anywhere in the host app. Hosts wire
  // their own hotkey (e.g. Cmd-Shift-K) by calling `openSearchPalette()`.
  // Internal binding is intentionally absent so the host's existing
  // command-palette / quick-open hotkeys don't fight ours.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onOpenEvt = () => setOpen(true);
    window.addEventListener(OPEN_EVENT, onOpenEvt);
    return () => window.removeEventListener(OPEN_EVENT, onOpenEvt);
  }, []);

  // Auto-focus input when opening.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => inputRef.current?.focus(), 30);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Lock body scroll while open + restore on close.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (open) {
      const prev = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
      return () => {
        document.body.style.overflow = prev;
      };
    }
  }, [open]);

  // Debounced search.
  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setHits(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    const handle = setTimeout(async () => {
      try {
        const { mode: serverMode, useTagsFilter } = serverModeFor(mode);
        const { data, errors } = await graphqlRequest<{ vaultSearch: Hit[] }>(
          PALETTE_SEARCH_QUERY,
          {
            query: useTagsFilter ? '' : trimmed,
            limit: 24,
            mode: serverMode,
            tags: useTagsFilter ? [trimmed] : undefined,
          },
        );
        if (cancelled) return;
        if (errors?.length) {
          console.warn('[search-palette] errors', errors);
          setHits([]);
        } else {
          setHits(data?.vaultSearch ?? []);
        }
        setActiveIdx(0);
      } catch (err) {
        console.warn('[search-palette] failed', err);
        if (!cancelled) setHits([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [open, query, mode, graphqlRequest]);

  const close = useCallback(() => {
    setOpen(false);
    setActiveIdx(0);
  }, []);

  const openHit = useCallback(
    (hit: Hit) => {
      saveRecent(query.trim());
      close();
      router.push(hrefFor(hit.note.path));
    },
    [close, hrefFor, query, router],
  );

  // Keyboard navigation across results.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
        return;
      }
      const list = hits ?? [];
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, Math.max(0, list.length - 1)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActiveIdx((i) => Math.max(0, i - 1));
      } else if (e.key === 'Enter') {
        if (list.length > 0 && activeIdx >= 0 && activeIdx < list.length) {
          e.preventDefault();
          openHit(list[activeIdx]);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, hits, activeIdx, close, openHit]);

  // Scroll the active row into view on arrow nav.
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(
      `[data-palette-hit-idx="${activeIdx}"]`,
    );
    el?.scrollIntoView({ block: 'nearest' });
  }, [activeIdx]);

  if (!mounted || !open) return null;

  const list = hits ?? [];
  const hasQuery = query.trim().length > 0;

  return createPortal(
    <div
      className={styles.paletteBackdrop}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Search vault"
    >
      <div className={styles.paletteSheet}>
        <div className={styles.paletteHandle} aria-hidden="true" />
        <div className={styles.paletteSearchRow}>
          <span className={styles.paletteSearchIcon} aria-hidden="true">⌕</span>
          <input
            ref={inputRef}
            type="search"
            className={styles.paletteInput}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the vault…"
            aria-label="Search the vault"
            autoComplete="off"
            spellCheck={false}
            // Don't let the browser's password-manager / autofill UI overlay
            // the palette on mobile.
            data-1p-ignore
            data-lpignore="true"
          />
          {query && (
            <button
              type="button"
              className={styles.paletteClearButton}
              onClick={() => {
                setQuery('');
                inputRef.current?.focus();
              }}
              aria-label="Clear query"
              title="Clear"
            >
              ✕
            </button>
          )}
          <button
            type="button"
            className={styles.paletteCloseButton}
            onClick={close}
            aria-label="Close search"
          >
            Esc
          </button>
        </div>

        <div className={styles.paletteModeRow} role="tablist" aria-label="Search mode">
          {visibleModes.map((m) => (
            <button
              key={m.id}
              type="button"
              role="tab"
              aria-selected={mode === m.id}
              className={
                mode === m.id
                  ? styles.paletteModeChipActive
                  : styles.paletteModeChip
              }
              onClick={() => setMode(m.id)}
              title={m.hint}
            >
              {m.label}
            </button>
          ))}
        </div>

        <div className={styles.paletteResults} aria-live="polite">
          {!hasQuery && recents.length > 0 && (
            <section className={styles.paletteSection}>
              <h4 className={styles.paletteSectionHeading}>Recent searches</h4>
              <ul className={styles.paletteRecentList}>
                {recents.map((r) => (
                  <li key={r}>
                    <button
                      type="button"
                      className={styles.paletteRecentChip}
                      onClick={() => {
                        setQuery(r);
                        inputRef.current?.focus();
                      }}
                    >
                      {r}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {!hasQuery && recents.length === 0 && (
            <div className={styles.paletteEmpty}>
              <p>Type to search the vault.</p>
              <p className={styles.paletteHint}>
                Tip: switch to <kbd>Full-text</kbd> for ranked tsvector hits with
                highlighted excerpts.
              </p>
            </div>
          )}

          {hasQuery && loading && list.length === 0 && (
            <ul className={styles.paletteResultList} aria-busy="true">
              {[0, 1, 2, 3].map((i) => (
                <li key={i} className={styles.paletteSkeleton}>
                  <span className={styles.paletteSkeletonTitle} />
                  <span className={styles.paletteSkeletonExcerpt} />
                </li>
              ))}
            </ul>
          )}

          {hasQuery && !loading && list.length === 0 && (
            <div className={styles.paletteEmpty}>
              <p>No matches for &ldquo;{query}&rdquo;.</p>
              <p className={styles.paletteHint}>
                Try a different word, or switch to <kbd>Tags</kbd> mode if you're
                searching by tag.
              </p>
            </div>
          )}

          {hasQuery && list.length > 0 && (
            <ul ref={listRef} className={styles.paletteResultList}>
              {list.map((hit, idx) => (
                <li
                  key={hit.note.path}
                  data-palette-hit-idx={idx}
                  className={
                    idx === activeIdx
                      ? styles.paletteHitActive
                      : styles.paletteHit
                  }
                  onMouseEnter={() => setActiveIdx(idx)}
                  onClick={() => openHit(hit)}
                >
                  <div className={styles.paletteHitHeader}>
                    <span className={styles.paletteHitTitle}>{hit.note.title}</span>
                    <span className={styles.paletteHitFolder}>
                      {hit.note.folder.replace(/^\d+\s*-\s*/, '')}
                    </span>
                    <span className={styles.paletteHitBadge}>
                      {hit.matchedOn}
                    </span>
                  </div>
                  {hit.excerpt && (
                    <div
                      className={styles.paletteHitExcerpt}
                      // Server returns ts_headline output with safe <b>
                      // wrappers around matched terms. Render as HTML so
                      // the highlights show.
                      dangerouslySetInnerHTML={{ __html: hit.excerpt }}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className={styles.paletteFooter} aria-hidden="true">
          <span><kbd>↑↓</kbd> navigate</span>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
