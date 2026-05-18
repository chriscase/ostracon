'use client';

import { useEffect, useState } from 'react';
import { useCodexNavigation } from './CodexAdapters';
import { noteHref } from './CodexTree';
import styles from './codex.module.css';

const FOLDER_OPTIONS = [
  '00 - Meta',
  '10 - Company',
  '20 - Products',
  '30 - Architecture',
  '40 - Concepts',
  '50 - Ideas & Inspiration',
  '60 - People & Roles',
  '80 - Daily',
];

interface Props {
  open: boolean;
  onClose: () => void;
}

const FILENAME_RE = /^[A-Za-z0-9 _\-().,&]+$/;

export default function NewNoteDialog({ open, onClose }: Props) {
  const { useRouter: useNavRouter } = useCodexNavigation();
  const router = useNavRouter();
  const [folder, setFolder] = useState<string>(FOLDER_OPTIONS[2]);
  const [filename, setFilename] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setFilename('');
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = filename.trim().replace(/\.md$/i, '');
    if (!trimmed) {
      setError('Filename is required');
      return;
    }
    if (!FILENAME_RE.test(trimmed)) {
      setError('Use letters, numbers, spaces, and basic punctuation (- _ . , & ( ))');
      return;
    }
    const rel = `${folder}/${trimmed}.md`;
    onClose();
    router.push(`${noteHref(rel)}?new=1`);
  }

  return (
    <div className={styles.modalBackdrop} onClick={onClose} role="presentation">
      <div className={styles.modal} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <h3 style={{ marginTop: 0 }}>New note</h3>
        <form onSubmit={handleCreate}>
          <label className={styles.modalLabel}>
            Folder
            <select
              className={styles.modalSelect}
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
            >
              {FOLDER_OPTIONS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </label>
          <label className={styles.modalLabel}>
            Filename
            <input
              className={styles.modalInput}
              type="text"
              value={filename}
              onChange={(e) => setFilename(e.target.value)}
              placeholder="My new document"
              autoFocus
            />
          </label>
          {error && <div className={styles.toastError}>{error}</div>}
          <div className={styles.editorActions} style={{ marginTop: '1rem' }}>
            <button type="button" onClick={onClose} className={styles.btnSecondary}>
              Cancel
            </button>
            <button type="submit" className={styles.btnPrimary}>
              Create &amp; edit
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Default template for a brand-new note. Caller passes this as initialContent. */
export function defaultNewNoteContent(title: string): string {
  return `---\ntags: []\n---\n\n# ${title}\n\n`;
}
