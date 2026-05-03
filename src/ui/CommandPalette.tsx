'use client';

// Cmd+K command palette (chriscase/abydonian#219).
//
// Action launcher that the rest of the codex UI registers actions into.
// Actions are simple { id, label, keywords?, when?, run } objects — no global
// state library, just a useState-backed list passed in by the parent.
//
// The palette filters actions by a token-based fuzzy match: every space-
// separated word in the query must appear (case-insensitive) somewhere in
// the action's label or keywords. Up arrow / down arrow / Enter navigate.

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import styles from './codex.module.css';

export interface PaletteAction {
  id: string;
  label: string;
  /** Extra strings to match against beyond the label. */
  keywords?: string[];
  /** Optional grouping label (e.g. "Note", "Folder", "Vault"). */
  category?: string;
  run: () => void;
}

interface Props {
  open: boolean;
  actions: PaletteAction[];
  onClose: () => void;
}

function matches(query: string, action: PaletteAction): boolean {
  if (!query.trim()) return true;
  const haystack = [
    action.label.toLowerCase(),
    ...(action.keywords ?? []).map((k) => k.toLowerCase()),
    (action.category ?? '').toLowerCase(),
  ].join(' ');
  return query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((token) => haystack.includes(token));
}

export default function CommandPalette({ open, actions, onClose }: Props) {
  const [query, setQuery] = useState<string>('');
  const [activeIndex, setActiveIndex] = useState<number>(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset state every time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery('');
      setActiveIndex(0);
      // Defer focus so the modal has rendered.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const filtered = useMemo(() => actions.filter((a) => matches(query, a)), [actions, query]);

  // Clamp active index when results change.
  useEffect(() => {
    if (activeIndex >= filtered.length) setActiveIndex(0);
  }, [filtered.length, activeIndex]);

  if (!open) return null;

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const action = filtered[activeIndex];
      if (action) {
        onClose();
        // Defer the action so the close-state propagates first.
        setTimeout(() => action.run(), 0);
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
          placeholder="Type a command…"
          spellCheck={false}
          data-allow-text="true"
        />
        <ul className={styles.paletteList} role="listbox">
          {filtered.length === 0 ? (
            <li className={styles.paletteEmpty}>No matching actions</li>
          ) : (
            filtered.map((action, idx) => (
              <li
                key={action.id}
                className={`${styles.paletteItem} ${idx === activeIndex ? styles.paletteItemActive : ''}`}
                role="option"
                aria-selected={idx === activeIndex}
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => {
                  onClose();
                  setTimeout(() => action.run(), 0);
                }}
              >
                {action.category && (
                  <span className={styles.paletteCategory}>{action.category}</span>
                )}
                <span>{action.label}</span>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}
