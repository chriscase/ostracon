'use client';

import { useEffect, useState } from 'react';
import { useCodexGraphqlRequest } from './CodexAdapters';
import styles from './codex.module.css';

const RENAME_NOTE = `
  mutation RenameNote($oldPath: String!, $newPath: String!, $commitMessage: String) {
    renameNote(oldPath: $oldPath, newPath: $newPath, commitMessage: $commitMessage) {
      kind
      newPath
      commitSha
      rewrittenFiles
      reason
    }
  }
`;

interface RenameResult {
  kind: 'OK' | 'NOT_FOUND' | 'CONFLICT' | 'AUTO_MANAGED' | 'INVALID';
  newPath?: string | null;
  commitSha?: string | null;
  rewrittenFiles?: string[] | null;
  reason?: string | null;
}

interface Props {
  open: boolean;
  oldPath: string;
  onClose: () => void;
  /** Called on a successful rename with the new vault-relative path. */
  onRenamed: (newPath: string, rewrittenCount: number) => void;
}

const PATH_RE = /^[A-Za-z0-9 _\-().,&/]+\.md$/;

export default function RenameDialog({ open, oldPath, onClose, onRenamed }: Props) {
  const graphqlRequest = useCodexGraphqlRequest();
  const [newPath, setNewPath] = useState<string>(oldPath);
  const [commitMessage, setCommitMessage] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);

  // Reset state every time the dialog opens for a fresh path.
  useEffect(() => {
    if (open) {
      setNewPath(oldPath);
      setCommitMessage('');
      setError(null);
      setSubmitting(false);
    }
  }, [open, oldPath]);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmed = newPath.trim();
    if (!trimmed) {
      setError('New path is required');
      return;
    }
    if (!trimmed.endsWith('.md')) {
      setError('New path must end with .md');
      return;
    }
    if (!PATH_RE.test(trimmed)) {
      setError(
        'Use letters, numbers, spaces, and basic punctuation (- _ . , & ( ) /). Path must end with .md',
      );
      return;
    }
    if (trimmed === oldPath) {
      setError('New path is the same as the current path');
      return;
    }

    setSubmitting(true);
    try {
      const { data, errors } = await graphqlRequest<{ renameNote: RenameResult }>(
        RENAME_NOTE,
        {
          oldPath,
          newPath: trimmed,
          commitMessage: commitMessage.trim() || undefined,
        },
      );

      if (errors?.length) {
        setError(errors.map((e) => e.message).join('; '));
        setSubmitting(false);
        return;
      }

      const result = data?.renameNote;
      if (!result) {
        setError('Empty response from server');
        setSubmitting(false);
        return;
      }

      switch (result.kind) {
        case 'OK': {
          const finalPath = result.newPath ?? trimmed;
          const rewritten = result.rewrittenFiles?.length ?? 0;
          onRenamed(finalPath, rewritten);
          break;
        }
        case 'NOT_FOUND':
        case 'CONFLICT':
        case 'AUTO_MANAGED':
        case 'INVALID':
          setError(result.reason ?? `Rename failed (${result.kind})`);
          setSubmitting(false);
          break;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rename failed');
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.modalBackdrop} onClick={onClose} role="presentation">
      <div
        className={styles.modal}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <h3 style={{ marginTop: 0 }}>Rename document</h3>
        <p style={{ marginTop: 0, fontSize: '0.85rem', opacity: 0.85 }}>
          Inbound wikilinks across the vault will be updated automatically. The
          rename and every rewrite are committed in a single git commit.
        </p>
        <form onSubmit={handleSubmit}>
          <label className={styles.modalLabel}>
            Current path
            <input
              className={styles.modalInput}
              type="text"
              value={oldPath}
              disabled
              readOnly
            />
          </label>
          <label className={styles.modalLabel}>
            New path
            <input
              className={styles.modalInput}
              type="text"
              value={newPath}
              onChange={(e) => setNewPath(e.target.value)}
              autoFocus
              spellCheck={false}
            />
          </label>
          <label className={styles.modalLabel}>
            Commit message (optional)
            <input
              className={styles.modalInput}
              type="text"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder={`Rename ${oldPath} → ${newPath} via admin panel`}
            />
          </label>
          {error && <div className={styles.toastError}>{error}</div>}
          <div className={styles.editorActions} style={{ marginTop: '1rem' }}>
            <button
              type="button"
              onClick={onClose}
              className={styles.btnSecondary}
              disabled={submitting}
            >
              Cancel
            </button>
            <button
              type="submit"
              className={styles.btnPrimary}
              disabled={submitting}
            >
              {submitting ? 'Renaming…' : 'Rename'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
