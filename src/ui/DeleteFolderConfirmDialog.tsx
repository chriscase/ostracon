'use client';

import { useEffect, useState } from 'react';
import { useCodexGraphqlRequest } from './CodexAdapters';
import styles from './codex.module.css';

const DELETE_FOLDER = `
  mutation DeleteFolder($path: String!, $force: Boolean, $commitMessage: String) {
    deleteFolder(path: $path, force: $force, commitMessage: $commitMessage) {
      kind
      commitSha
      deletedFiles
      orphanedFiles
      fileCount
      reason
    }
  }
`;

interface DeleteFolderResult {
  kind: 'OK' | 'NOT_FOUND' | 'NOT_EMPTY' | 'AUTO_MANAGED' | 'INVALID';
  commitSha?: string | null;
  deletedFiles?: string[] | null;
  orphanedFiles?: string[] | null;
  fileCount?: number | null;
  reason?: string | null;
}

interface Props {
  open: boolean;
  path: string;
  onClose: () => void;
  onDeleted: (deletedCount: number, orphanCount: number) => void;
}

function folderName(path: string): string {
  return path.split('/').pop() ?? path;
}

export default function DeleteFolderConfirmDialog({
  open,
  path,
  onClose,
  onDeleted,
}: Props) {
  const graphqlRequest = useCodexGraphqlRequest();
  const [confirmText, setConfirmText] = useState<string>('');
  const [commitMessage, setCommitMessage] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [probeResult, setProbeResult] = useState<{
    fileCount: number;
    requiresForce: boolean;
  } | null>(null);
  const [probing, setProbing] = useState<boolean>(false);

  const expectedConfirmation = folderName(path);

  // Probe by calling deleteFolder without force — if non-empty, we get back a
  // file count without actually deleting anything (the mutation returns
  // NOT_EMPTY before fs.rm). For an empty folder, the call would actually
  // delete it, so we don't probe — assume requiresForce=false.
  useEffect(() => {
    if (!open) return;
    setConfirmText('');
    setCommitMessage('');
    setError(null);
    setSubmitting(false);
    setProbeResult(null);

    let cancelled = false;
    setProbing(true);
    (async () => {
      try {
        const { data } = await graphqlRequest<{ deleteFolder: DeleteFolderResult }>(
          DELETE_FOLDER,
          { path, force: false },
        );
        if (cancelled) return;
        const probe = data?.deleteFolder;
        if (probe?.kind === 'NOT_EMPTY') {
          setProbeResult({ fileCount: probe.fileCount ?? 0, requiresForce: true });
        } else if (probe?.kind === 'OK') {
          // Empty-folder delete already happened — close + report.
          onDeleted(probe.deletedFiles?.length ?? 0, probe.orphanedFiles?.length ?? 0);
        } else {
          setError(probe?.reason ?? `Probe failed (${probe?.kind})`);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to probe folder');
        }
      } finally {
        if (!cancelled) setProbing(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, path, onDeleted]);

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
      const { data, errors } = await graphqlRequest<{ deleteFolder: DeleteFolderResult }>(
        DELETE_FOLDER,
        {
          path,
          force: true,
          commitMessage: commitMessage.trim() || undefined,
        },
      );
      if (errors?.length) {
        setError(errors.map((e) => e.message).join('; '));
        setSubmitting(false);
        return;
      }
      const result = data?.deleteFolder;
      if (!result) {
        setError('Empty response from server');
        setSubmitting(false);
        return;
      }
      switch (result.kind) {
        case 'OK':
          onDeleted(
            result.deletedFiles?.length ?? 0,
            result.orphanedFiles?.length ?? 0,
          );
          break;
        default:
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
        <h3 style={{ marginTop: 0 }}>Delete folder</h3>
        <p style={{ marginTop: 0, fontSize: '0.85rem' }}>
          You are about to delete <strong>{path}</strong> and everything inside.
          This action cannot be undone.
        </p>
        {probing ? (
          <div className={styles.spinnerWrap}>Checking folder contents…</div>
        ) : probeResult && probeResult.requiresForce ? (
          <div className={styles.toastError} style={{ marginBottom: '0.75rem' }}>
            <strong>
              Warning: {probeResult.fileCount} note{probeResult.fileCount === 1 ? '' : 's'} will
              be permanently deleted.
            </strong>
            <p style={{ marginTop: '0.5rem', marginBottom: 0, fontSize: '0.8rem' }}>
              Inbound wikilinks from outside the folder will become orphans.
              Submitting this dialog passes <code>force=true</code> to the mutation.
            </p>
          </div>
        ) : null}

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
              disabled={probing}
            />
          </label>
          <label className={styles.modalLabel}>
            Commit message (optional)
            <input
              className={styles.modalInput}
              type="text"
              value={commitMessage}
              onChange={(e) => setCommitMessage(e.target.value)}
              placeholder={`Delete folder ${path} via admin panel`}
              disabled={probing}
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
              disabled={submitting || probing || !canConfirm}
            >
              {submitting ? 'Deleting…' : 'Delete folder permanently'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
