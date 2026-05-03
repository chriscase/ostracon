'use client';

import { useEffect, useState } from 'react';
import { useCodexGraphqlRequest } from './CodexAdapters';
import styles from './codex.module.css';

const RENAME_FOLDER = `
  mutation RenameFolder($oldPath: String!, $newPath: String!, $commitMessage: String) {
    renameFolder(oldPath: $oldPath, newPath: $newPath, commitMessage: $commitMessage) {
      kind
      newPath
      commitSha
      renamedNotes
      rewrittenFiles
      reason
    }
  }
`;

interface RenameFolderResult {
  kind: 'OK' | 'NOT_FOUND' | 'CONFLICT' | 'AUTO_MANAGED' | 'INVALID';
  newPath?: string | null;
  commitSha?: string | null;
  renamedNotes?: number | null;
  rewrittenFiles?: string[] | null;
  reason?: string | null;
}

interface Props {
  open: boolean;
  oldPath: string;
  onClose: () => void;
  onRenamed: (newPath: string, renamedNotes: number, rewrittenCount: number) => void;
}

const FOLDER_PATH_RE = /^[A-Za-z0-9 _\-().,&/]+$/;

export default function RenameFolderDialog({ open, oldPath, onClose, onRenamed }: Props) {
  const graphqlRequest = useCodexGraphqlRequest();
  const [newPath, setNewPath] = useState<string>(oldPath);
  const [commitMessage, setCommitMessage] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);

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

    const trimmed = newPath.trim().replace(/\/+$/g, '');
    if (!trimmed) {
      setError('New folder path is required');
      return;
    }
    if (!FOLDER_PATH_RE.test(trimmed)) {
      setError('Use letters, numbers, spaces, slashes, and basic punctuation (- _ . , & ( ) /).');
      return;
    }
    if (trimmed === oldPath) {
      setError('New path is the same as the current path');
      return;
    }

    setSubmitting(true);
    try {
      const { data, errors } = await graphqlRequest<{ renameFolder: RenameFolderResult }>(
        RENAME_FOLDER,
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
      const result = data?.renameFolder;
      if (!result) {
        setError('Empty response from server');
        setSubmitting(false);
        return;
      }
      switch (result.kind) {
        case 'OK': {
          const finalPath = result.newPath ?? trimmed;
          onRenamed(
            finalPath,
            result.renamedNotes ?? 0,
            result.rewrittenFiles?.length ?? 0,
          );
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
        <h3 style={{ marginTop: 0 }}>Rename folder</h3>
        <p style={{ marginTop: 0, fontSize: '0.85rem', opacity: 0.85 }}>
          Renames every note inside this folder. Inbound wikilinks across the
          vault are rewritten automatically. The whole operation lands in a
          single git commit.
        </p>
        <form onSubmit={handleSubmit}>
          <label className={styles.modalLabel}>
            Current folder
            <input
              className={styles.modalInput}
              type="text"
              value={oldPath}
              disabled
              readOnly
            />
          </label>
          <label className={styles.modalLabel}>
            New folder path
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
              placeholder={`Rename folder ${oldPath} → ${newPath} via admin panel`}
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
              {submitting ? 'Renaming…' : 'Rename folder'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
