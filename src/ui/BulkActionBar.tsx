'use client';

// Bulk action bar (chriscase/abydonian#225).
//
// Renders above the tree when ≥2 notes are selected via Cmd/Shift-click.
// Actions invoke the existing single-note mutations in a loop (one git
// commit per file). The "atomic batch" version of the operations would
// require new mutation surface; for v1 we accept N commits per bulk action
// and present a single end-of-batch toast summarizing the result.

import { useCallback, useState } from 'react';
import { useCodexGraphqlRequest } from './CodexAdapters';
import styles from './codex.module.css';

const DELETE_NOTE = `
  mutation DeleteNote($path: String!) {
    deleteNote(path: $path) { kind reason }
  }
`;

const MOVE_NOTE = `
  mutation MoveNote($oldPath: String!, $newParentPath: String!) {
    moveNote(oldPath: $oldPath, newParentPath: $newParentPath) {
      kind newPath reason
    }
  }
`;

const SAVE_NOTE = `
  mutation SaveNote($path: String!, $content: String!, $baseSha: String!) {
    saveNote(path: $path, content: $content, baseSha: $baseSha) {
      kind newSha reason
    }
  }
`;

const FETCH_NOTE = `
  query FetchForBulkTag($path: String!) {
    vaultNote(path: $path) {
      sha
      content
    }
  }
`;

interface Props {
  /** Currently-selected vault paths (.md). Bar shows when length ≥ 2. */
  selectedPaths: string[];
  /** Reset multi-selection in the parent. */
  onClearSelection: () => void;
  /** Refresh the tree + show a toast with the supplied summary. */
  onBatchComplete: (summary: string) => void;
}

type BulkOpKind = 'delete' | 'move' | 'tag-add' | 'tag-remove';

export default function BulkActionBar({
  selectedPaths,
  onClearSelection,
  onBatchComplete,
}: Props) {
  const graphqlRequest = useCodexGraphqlRequest();
  const [busy, setBusy] = useState<boolean>(false);
  const [pendingOp, setPendingOp] = useState<BulkOpKind | null>(null);
  const [moveTarget, setMoveTarget] = useState<string>('');
  const [tag, setTag] = useState<string>('');

  const cancelOp = useCallback(() => {
    setPendingOp(null);
    setMoveTarget('');
    setTag('');
  }, []);

  const runDelete = useCallback(async () => {
    if (
      !confirm(
        `Permanently delete ${selectedPaths.length} note${selectedPaths.length === 1 ? '' : 's'}? This is one git commit per file.`,
      )
    )
      return;
    setBusy(true);
    let ok = 0;
    const failures: Array<{ path: string; reason: string }> = [];
    try {
      for (const path of selectedPaths) {
        const { data, errors } = await graphqlRequest<{
          deleteNote: { kind: string; reason?: string | null };
        }>(DELETE_NOTE, { path });
        if (errors?.length || data?.deleteNote.kind !== 'OK') {
          failures.push({
            path,
            reason:
              errors?.map((e) => e.message).join('; ') ??
              data?.deleteNote.reason ??
              'Unknown error',
          });
        } else {
          ok++;
        }
      }
      cancelOp();
      onClearSelection();
      onBatchComplete(
        `Bulk delete · ${ok} ok${failures.length > 0 ? ` · ${failures.length} failed` : ''}`,
      );
    } finally {
      setBusy(false);
    }
  }, [selectedPaths, cancelOp, onClearSelection, onBatchComplete]);

  const runMove = useCallback(async () => {
    const dest = moveTarget.trim().replace(/\/+$/, '');
    if (!dest) {
      alert('Enter a destination folder path');
      return;
    }
    if (
      !confirm(
        `Move ${selectedPaths.length} note${selectedPaths.length === 1 ? '' : 's'} into "${dest}"? One git commit per file.`,
      )
    )
      return;
    setBusy(true);
    let ok = 0;
    const failures: Array<{ path: string; reason: string }> = [];
    try {
      for (const path of selectedPaths) {
        const { data, errors } = await graphqlRequest<{
          moveNote: { kind: string; reason?: string | null };
        }>(MOVE_NOTE, { oldPath: path, newParentPath: dest });
        if (errors?.length || data?.moveNote.kind !== 'OK') {
          failures.push({
            path,
            reason:
              errors?.map((e) => e.message).join('; ') ??
              data?.moveNote.reason ??
              'Unknown error',
          });
        } else {
          ok++;
        }
      }
      cancelOp();
      onClearSelection();
      onBatchComplete(
        `Bulk move → ${dest} · ${ok} ok${failures.length > 0 ? ` · ${failures.length} failed` : ''}`,
      );
    } finally {
      setBusy(false);
    }
  }, [selectedPaths, moveTarget, cancelOp, onClearSelection, onBatchComplete]);

  const runTagOp = useCallback(
    async (mode: 'add' | 'remove') => {
      const t = tag.trim();
      if (!t) {
        alert('Enter a tag');
        return;
      }
      if (
        !confirm(
          `${mode === 'add' ? 'Add' : 'Remove'} tag #${t} ${mode === 'add' ? 'to' : 'from'} ${selectedPaths.length} note${selectedPaths.length === 1 ? '' : 's'}? One git commit per file.`,
        )
      )
        return;
      setBusy(true);
      let ok = 0;
      const failures: Array<{ path: string; reason: string }> = [];
      try {
        for (const path of selectedPaths) {
          // Read-modify-write: fetch current frontmatter+body, mutate the
          // tag list, save. The vault sync engine handles the optimistic-
          // concurrency check on baseSha.
          const { data: fetch, errors: fetchErrors } = await graphqlRequest<{
            vaultNote: { sha: string; content: string } | null;
          }>(FETCH_NOTE, { path });
          if (fetchErrors?.length || !fetch?.vaultNote) {
            failures.push({
              path,
              reason:
                fetchErrors?.map((e) => e.message).join('; ') ??
                'Note not found',
            });
            continue;
          }
          const { sha, content } = fetch.vaultNote;
          const next = applyTagToFrontmatter(content, t, mode);
          if (next === content) {
            ok++; // already in desired state
            continue;
          }
          const { data: save, errors: saveErrors } = await graphqlRequest<{
            saveNote: { kind: string; reason?: string | null };
          }>(SAVE_NOTE, { path, content: next, baseSha: sha });
          if (saveErrors?.length || save?.saveNote.kind !== 'OK') {
            failures.push({
              path,
              reason:
                saveErrors?.map((e) => e.message).join('; ') ??
                save?.saveNote.reason ??
                'Save failed',
            });
          } else {
            ok++;
          }
        }
        cancelOp();
        onClearSelection();
        onBatchComplete(
          `Bulk ${mode === 'add' ? 'tag-add' : 'tag-remove'} #${t} · ${ok} ok${failures.length > 0 ? ` · ${failures.length} failed` : ''}`,
        );
      } finally {
        setBusy(false);
      }
    },
    [selectedPaths, tag, cancelOp, onClearSelection, onBatchComplete],
  );

  if (selectedPaths.length < 2) return null;

  return (
    <div className={styles.bulkActionBar}>
      <div className={styles.bulkActionHeader}>
        <strong>{selectedPaths.length}</strong> selected
        <button
          type="button"
          className={styles.bulkActionClear}
          onClick={onClearSelection}
          disabled={busy}
        >
          clear
        </button>
      </div>
      {pendingOp === null ? (
        <div className={styles.bulkActionButtons}>
          <button
            type="button"
            className={styles.btnSecondary}
            disabled={busy}
            onClick={() => setPendingOp('move')}
          >
            Move…
          </button>
          <button
            type="button"
            className={styles.btnSecondary}
            disabled={busy}
            onClick={() => setPendingOp('tag-add')}
          >
            Add tag…
          </button>
          <button
            type="button"
            className={styles.btnSecondary}
            disabled={busy}
            onClick={() => setPendingOp('tag-remove')}
          >
            Remove tag…
          </button>
          <button
            type="button"
            className={styles.btnDanger}
            disabled={busy}
            onClick={runDelete}
          >
            Delete…
          </button>
        </div>
      ) : pendingOp === 'move' ? (
        <div className={styles.bulkActionForm}>
          <input
            type="text"
            className={styles.modalInput}
            placeholder="destination folder, e.g. 30 - Architecture"
            value={moveTarget}
            onChange={(e) => setMoveTarget(e.target.value)}
            autoFocus
          />
          <button
            type="button"
            className={styles.btnPrimary}
            disabled={busy || !moveTarget.trim()}
            onClick={runMove}
          >
            {busy ? 'Moving…' : 'Move'}
          </button>
          <button type="button" className={styles.btnSecondary} onClick={cancelOp} disabled={busy}>
            Cancel
          </button>
        </div>
      ) : (
        <div className={styles.bulkActionForm}>
          <input
            type="text"
            className={styles.modalInput}
            placeholder="tag (e.g. ported)"
            value={tag}
            onChange={(e) => setTag(e.target.value)}
            autoFocus
          />
          <button
            type="button"
            className={styles.btnPrimary}
            disabled={busy || !tag.trim()}
            onClick={() => runTagOp(pendingOp === 'tag-add' ? 'add' : 'remove')}
          >
            {busy
              ? pendingOp === 'tag-add'
                ? 'Adding…'
                : 'Removing…'
              : pendingOp === 'tag-add'
                ? 'Add tag'
                : 'Remove tag'}
          </button>
          <button type="button" className={styles.btnSecondary} onClick={cancelOp} disabled={busy}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Insert or remove a tag inside the YAML frontmatter of a note. Tries to be
 * gentle about formatting:
 *   - If frontmatter exists with a tags: array, append/remove without
 *     reformatting the rest.
 *   - If frontmatter exists without tags, insert a `tags: [<tag>]` line.
 *   - If no frontmatter, prepend `---\ntags: [<tag>]\n---\n\n`.
 */
function applyTagToFrontmatter(content: string, tag: string, mode: 'add' | 'remove'): string {
  const t = tag.trim();
  if (!t) return content;
  const FENCE_RE = /^---\n([\s\S]*?)\n---\n?/;
  const match = content.match(FENCE_RE);
  if (!match) {
    if (mode === 'remove') return content;
    return `---\ntags: [${t}]\n---\n\n${content}`;
  }
  const yaml = match[1];
  const rest = content.slice(match[0].length);
  // Find existing tags line
  const tagsLineRe = /(^|\n)tags:\s*(\[[^\]]*\]|[^\n]*)/;
  const tagsMatch = yaml.match(tagsLineRe);
  if (!tagsMatch) {
    if (mode === 'remove') return content;
    const newYaml = yaml ? `${yaml}\ntags: [${t}]` : `tags: [${t}]`;
    return `---\n${newYaml}\n---\n${rest.startsWith('\n') ? '' : '\n'}${rest}`;
  }
  const existingValue = tagsMatch[2];
  const tags = parseTagsValue(existingValue);
  let nextTags: string[];
  if (mode === 'add') {
    if (tags.includes(t)) return content;
    nextTags = [...tags, t];
  } else {
    if (!tags.includes(t)) return content;
    nextTags = tags.filter((x) => x !== t);
  }
  const newTagsLine = `tags: [${nextTags.join(', ')}]`;
  const newYaml = yaml.replace(tagsLineRe, (_full, lead) => `${lead}${newTagsLine}`);
  return `---\n${newYaml}\n---\n${rest.startsWith('\n') ? '' : '\n'}${rest}`;
}

function parseTagsValue(raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed.startsWith('[')) {
    return trimmed
      .slice(1, trimmed.endsWith(']') ? -1 : undefined)
      .split(',')
      .map((s) => s.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
  }
  return trimmed
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
