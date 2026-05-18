'use client';

import { useEffect, useState } from 'react';
import { useCodexGraphqlRequest } from './CodexAdapters';
import styles from './codex.module.css';

const NOTE_INBOUND_QUERY = `
  query NoteInbound($path: String!) {
    vaultNote(path: $path) {
      title
      inboundLinks {
        path
        title
        folder
      }
    }
  }
`;

const DELETE_NOTE = `
  mutation DeleteNote($path: String!, $commitMessage: String) {
    deleteNote(path: $path, commitMessage: $commitMessage) {
      kind
      commitSha
      orphanedFiles
      reason
    }
  }
`;

interface DeleteResult {
  kind: 'OK' | 'NOT_FOUND' | 'AUTO_MANAGED' | 'INVALID';
  commitSha?: string | null;
  orphanedFiles?: string[] | null;
  reason?: string | null;
}

interface InboundLink {
  path: string;
  title: string;
  folder: string;
}

interface Props {
  open: boolean;
  path: string;
  onClose: () => void;
  /** Called on successful delete with the count of inbound links that became orphan. */
  onDeleted: (orphanCount: number) => void;
}

function noteTitle(path: string): string {
  return path.split('/').pop()?.replace(/\.md$/i, '') ?? path;
}

export default function DeleteConfirmDialog({ open, path, onClose, onDeleted }: Props) {
  const graphqlRequest = useCodexGraphqlRequest();
  const [confirmText, setConfirmText] = useState<string>('');
  const [commitMessage, setCommitMessage] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [inboundLinks, setInboundLinks] = useState<InboundLink[] | null>(null);
  const [loadingLinks, setLoadingLinks] = useState<boolean>(false);

  const expectedConfirmation = noteTitle(path);

  useEffect(() => {
    if (!open) return;
    setConfirmText('');
    setCommitMessage('');
    setError(null);
    setSubmitting(false);
    setInboundLinks(null);

    let cancelled = false;
    setLoadingLinks(true);
    (async () => {
      try {
        const { data, errors } = await graphqlRequest<{
          vaultNote: { title: string; inboundLinks: InboundLink[] } | null;
        }>(NOTE_INBOUND_QUERY, { path });
        if (cancelled) return;
        if (errors?.length) {
          setError(errors.map((e) => e.message).join('; '));
          setInboundLinks([]);
        } else {
          setInboundLinks(data?.vaultNote?.inboundLinks ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load inbound links');
          setInboundLinks([]);
        }
      } finally {
        if (!cancelled) setLoadingLinks(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, path]);

  if (!open) return null;

  const canConfirm = confirmText === expectedConfirmation;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!canConfirm) {
      setError(`Type "${expectedConfirmation}" exactly to confirm.`);
      return;
    }
    setSubmitting(true);
    try {
      const { data, errors } = await graphqlRequest<{ deleteNote: DeleteResult }>(
        DELETE_NOTE,
        {
          path,
          commitMessage: commitMessage.trim() || undefined,
        },
      );
      if (errors?.length) {
        setError(errors.map((e) => e.message).join('; '));
        setSubmitting(false);
        return;
      }
      const result = data?.deleteNote;
      if (!result) {
        setError('Empty response from server');
        setSubmitting(false);
        return;
      }
      switch (result.kind) {
        case 'OK':
          onDeleted(result.orphanedFiles?.length ?? 0);
          break;
        case 'NOT_FOUND':
        case 'AUTO_MANAGED':
        case 'INVALID':
          setError(result.reason ?? `Delete failed (${result.kind})`);
          setSubmitting(false);
          break;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
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
        <h3 style={{ marginTop: 0 }}>Delete document</h3>
        <p style={{ marginTop: 0, fontSize: '0.85rem' }}>
          You are about to delete <strong>{path}</strong>. This action cannot be undone
          (the file is removed from the vault and committed to git history).
        </p>
        {loadingLinks ? (
          <div className={styles.spinnerWrap}>Loading inbound links…</div>
        ) : inboundLinks && inboundLinks.length > 0 ? (
          <div className={styles.toastError} style={{ marginBottom: '0.75rem' }}>
            <strong>
              Warning: {inboundLinks.length} note{inboundLinks.length === 1 ? '' : 's'} link
              {inboundLinks.length === 1 ? 's' : ''} to this note. Those links will become
              orphans after delete.
            </strong>
            <ul style={{ margin: '0.5rem 0 0 1rem', padding: 0, fontSize: '0.8rem' }}>
              {inboundLinks.slice(0, 8).map((link) => (
                <li key={link.path}>
                  <code>{link.path}</code>
                </li>
              ))}
              {inboundLinks.length > 8 && (
                <li>… and {inboundLinks.length - 8} more</li>
              )}
            </ul>
          </div>
        ) : (
          inboundLinks && (
            <p style={{ fontSize: '0.85rem', opacity: 0.85 }}>
              No other notes link to this one — safe to delete.
            </p>
          )
        )}

        <form onSubmit={handleSubmit}>
          <label className={styles.modalLabel}>
            Type <code>{expectedConfirmation}</code> to confirm
            <input
              className={styles.modalInput}
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
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
              placeholder={`Delete ${path} via admin panel`}
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
              className={styles.btnDanger}
              disabled={submitting || !canConfirm}
            >
              {submitting ? 'Deleting…' : 'Delete permanently'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
