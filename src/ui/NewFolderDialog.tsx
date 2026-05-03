'use client';

import { useEffect, useState } from 'react';
import { useCodexGraphqlRequest } from './CodexAdapters';
import styles from './codex.module.css';

const CREATE_FOLDER = `
  mutation CreateFolder($path: String!, $commitMessage: String) {
    createFolder(path: $path, commitMessage: $commitMessage) {
      kind
      path
      commitSha
      reason
    }
  }
`;

interface CreateFolderResult {
  kind: 'OK' | 'CONFLICT' | 'AUTO_MANAGED' | 'INVALID';
  path?: string | null;
  commitSha?: string | null;
  reason?: string | null;
}

interface Props {
  open: boolean;
  /** When provided, the new folder is created underneath this parent path. */
  parentPath?: string;
  onClose: () => void;
  onCreated: (path: string) => void;
}

const FOLDER_NAME_RE = /^[A-Za-z0-9 _\-().,&]+$/;

export default function NewFolderDialog({ open, parentPath, onClose, onCreated }: Props) {
  const graphqlRequest = useCodexGraphqlRequest();
  const [folderName, setFolderName] = useState<string>('');
  const [commitMessage, setCommitMessage] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);

  useEffect(() => {
    if (open) {
      setFolderName('');
      setCommitMessage('');
      setError(null);
      setSubmitting(false);
    }
  }, [open]);

  if (!open) return null;

  const fullPath = parentPath ? `${parentPath}/${folderName.trim()}` : folderName.trim();

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const trimmed = folderName.trim();
    if (!trimmed) {
      setError('Folder name is required');
      return;
    }
    if (!FOLDER_NAME_RE.test(trimmed)) {
      setError('Use letters, numbers, spaces, and basic punctuation (- _ . , & ( ))');
      return;
    }

    setSubmitting(true);
    try {
      const { data, errors } = await graphqlRequest<{ createFolder: CreateFolderResult }>(
        CREATE_FOLDER,
        {
          path: fullPath,
          commitMessage: commitMessage.trim() || undefined,
        },
      );
      if (errors?.length) {
        setError(errors.map((e) => e.message).join('; '));
        setSubmitting(false);
        return;
      }
      const result = data?.createFolder;
      if (!result) {
        setError('Empty response from server');
        setSubmitting(false);
        return;
      }
      switch (result.kind) {
        case 'OK':
          onCreated(result.path ?? fullPath);
          break;
        case 'CONFLICT':
        case 'AUTO_MANAGED':
        case 'INVALID':
          setError(result.reason ?? `Create failed (${result.kind})`);
          setSubmitting(false);
          break;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
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
        <h3 style={{ marginTop: 0 }}>New folder</h3>
        {parentPath && (
          <p style={{ marginTop: 0, fontSize: '0.85rem', opacity: 0.85 }}>
            Inside <code>{parentPath}</code>
          </p>
        )}
        <form onSubmit={handleSubmit}>
          <label className={styles.modalLabel}>
            Folder name
            <input
              className={styles.modalInput}
              type="text"
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              autoFocus
              placeholder="My new folder"
              spellCheck={false}
            />
          </label>
          {folderName.trim() && (
            <p style={{ fontSize: '0.75rem', opacity: 0.7, margin: '0 0 0.5rem 0' }}>
              Will be created at <code>{fullPath}</code>
            </p>
          )}
          <label className={styles.modalLabel}>
            Commit message (optional)
            <input
              className={styles.modalInput}
              type="text"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder={`Create folder ${fullPath || '...'} via admin panel`}
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
              disabled={submitting || !folderName.trim()}
            >
              {submitting ? 'Creating…' : 'Create folder'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
