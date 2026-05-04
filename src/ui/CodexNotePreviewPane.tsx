'use client';

import { useEffect, useState } from 'react';
import { useCodexGraphqlRequest } from './CodexAdapters';
import CodexPreview, { type CodexNote } from './CodexPreview';
import styles from './codex.module.css';

const NOTE_QUERY = `
  query VaultNote($path: String!) {
    vaultNote(path: $path) {
      path
      title
      folder
      status
      tags
      isAutoManaged
      sha
      content
      outboundLinks {
        target
        anchor
        alias
        isEmbed
        resolvedPath
      }
      inboundLinks {
        path
        title
        folder
        status
      }
    }
  }
`;

interface Props {
  notePath: string;
  onClose: () => void;
  onOpenLinkages: (notePath: string) => void;
  onEdit: (notePath: string) => void;
}

/**
 * Side pane that fetches + renders a vault note inline. Uses the existing
 * CodexPreview component so we get all the polish (wikilink rewriting,
 * image embeds, status badges, inbound-link list) for free.
 *
 * Designed to live alongside the graph canvas — hosts pass it as a sibling
 * inside a flex row container.
 */
export default function CodexNotePreviewPane({
  notePath,
  onClose,
  onOpenLinkages,
  onEdit,
}: Props) {
  const graphqlRequest = useCodexGraphqlRequest();
  const [note, setNote] = useState<CodexNote | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNote(null);
    (async () => {
      try {
        const { data, errors } = await graphqlRequest<{ vaultNote: CodexNote | null }>(
          NOTE_QUERY,
          { path: notePath },
        );
        if (cancelled) return;
        if (errors?.length) {
          setError(errors.map((e) => e.message).join('; '));
        } else if (!data?.vaultNote) {
          setError(`Note not found: ${notePath}`);
        } else {
          setNote(data.vaultNote);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load note');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [notePath]);

  return (
    <div className={styles.notePreviewPane}>
      <div className={styles.notePreviewPaneHeader}>
        <span className={styles.notePreviewPaneTitle}>
          {note?.title ?? notePath.split(/[\\/]/).pop()?.replace(/\.md$/i, '') ?? notePath}
        </span>
        <div className={styles.notePreviewPaneActions}>
          <button
            type="button"
            className={styles.notePreviewPaneActionBtn}
            onClick={() => onOpenLinkages(notePath)}
            title="Open this note's linkages graph (centered on this note)"
          >
            🕸
          </button>
          <button
            type="button"
            className={styles.notePreviewPaneActionBtn}
            onClick={() => onEdit(notePath)}
            title="Open this note in editor"
          >
            ✎
          </button>
          <button
            type="button"
            className={styles.notePreviewPaneActionBtn}
            onClick={onClose}
            title="Close preview"
            aria-label="Close preview pane"
          >
            ×
          </button>
        </div>
      </div>
      <div className={styles.notePreviewPaneBody}>
        {loading && <div className={styles.spinnerWrap}>Loading…</div>}
        {error && <div className={styles.error}>{error}</div>}
        {note && <CodexPreview note={note} />}
      </div>
    </div>
  );
}
