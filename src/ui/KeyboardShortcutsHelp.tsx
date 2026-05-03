'use client';

// Cmd+? help dialog (chriscase/abydonian#219).
//
// Lists every shortcut currently registered via registerShortcutHelp().
// Components register themselves on mount; the dialog re-renders on changes.

import { useMemo } from 'react';
import { useShortcutHelp, formatCombo } from './useKeyboardShortcuts';
import styles from './codex.module.css';

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function KeyboardShortcutsHelp({ open, onClose }: Props) {
  const entries = useShortcutHelp();
  const grouped = useMemo(() => {
    const groups = new Map<string, typeof entries>();
    for (const entry of entries) {
      const cat = entry.category ?? 'General';
      const arr = groups.get(cat) ?? [];
      arr.push(entry);
      groups.set(cat, arr);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [entries]);

  if (!open) return null;

  return (
    <div className={styles.modalBackdrop} onClick={onClose} role="presentation">
      <div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <h3 style={{ marginTop: 0 }}>Keyboard shortcuts</h3>
        {grouped.length === 0 ? (
          <p style={{ marginTop: 0, fontSize: '0.85rem', opacity: 0.7 }}>
            No shortcuts registered.
          </p>
        ) : (
          grouped.map(([category, items]) => (
            <div key={category} className={styles.shortcutGroup}>
              <h4 className={styles.shortcutGroupHeader}>{category}</h4>
              <ul className={styles.shortcutList}>
                {items.map((entry) => (
                  <li key={entry.combo} className={styles.shortcutRow}>
                    <span>{entry.label}</span>
                    <kbd className={styles.kbd}>{formatCombo(entry.combo)}</kbd>
                  </li>
                ))}
              </ul>
            </div>
          ))
        )}
        <div className={styles.editorActions} style={{ marginTop: '1rem' }}>
          <button type="button" onClick={onClose} className={styles.btnSecondary}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
