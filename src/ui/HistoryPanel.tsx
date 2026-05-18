'use client';

// Per-note history panel (chriscase/abydonian#223 + #224).
//
// Loads commit history for the open note via the vaultNoteHistory query,
// renders each entry with a colorized unified diff. A "Revert to this
// version" button next to each entry confirms then calls the revertNote
// mutation. The first/most-recent entry is implicitly "current" and offers
// no revert button.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCodexGraphqlRequest } from './CodexAdapters';
import styles from './codex.module.css';

const HISTORY_QUERY = `
  query VaultNoteHistory($path: String!, $limit: Int) {
    vaultNoteHistory(path: $path, limit: $limit) {
      sha
      shortSha
      authorName
      authorEmail
      date
      message
      diff
    }
  }
`;

const REVERT_NOTE = `
  mutation RevertNote($path: String!, $sha: String!, $commitMessage: String) {
    revertNote(path: $path, sha: $sha, commitMessage: $commitMessage) {
      kind
      commitSha
      newSha
      reason
    }
  }
`;

interface HistoryEntry {
  sha: string;
  shortSha: string;
  authorName: string;
  authorEmail: string;
  date: string;
  message: string;
  diff: string;
}

interface RevertResult {
  kind: 'OK' | 'NOT_FOUND' | 'AUTO_MANAGED' | 'NOOP' | 'INVALID';
  commitSha?: string | null;
  newSha?: string | null;
  reason?: string | null;
}

interface Props {
  path: string;
  /** When the note is auto-managed, hide revert buttons but still show history. */
  isAutoManaged?: boolean;
  /** Called after a successful revert so the parent can refresh the note. */
  onReverted?: (newCommitSha: string) => void;
  onClose?: () => void;
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleString();
  } catch {
    return iso;
  }
}

function colorizeDiff(diff: string) {
  // Split into lines and render each with a class. Preserve the original
  // newlines to keep the unified diff structure intact.
  return diff.split('\n').map((line, idx) => {
    let cls: string | undefined;
    if (line.startsWith('+++') || line.startsWith('---')) cls = styles.historyDiffHunk;
    else if (line.startsWith('@@')) cls = styles.historyDiffHunk;
    else if (line.startsWith('+')) cls = styles.historyDiffAdd;
    else if (line.startsWith('-')) cls = styles.historyDiffDel;
    return (
      <div key={idx} className={cls}>
        {line || ' '}
      </div>
    );
  });
}

export default function HistoryPanel({
  path,
  isAutoManaged,
  onReverted,
  onClose,
}: Props) {
  const graphqlRequest = useCodexGraphqlRequest();
  const panelRef = useRef<HTMLDivElement>(null);
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [activeSha, setActiveSha] = useState<string | null>(null);
  const [reverting, setReverting] = useState<boolean>(false);
  const [revertError, setRevertError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, errors } = await graphqlRequest<{ vaultNoteHistory: HistoryEntry[] }>(
        HISTORY_QUERY,
        { path, limit: 50 },
      );
      if (errors?.length) {
        setError(errors.map((e) => e.message).join('; '));
        setEntries([]);
      } else {
        const list = data?.vaultNoteHistory ?? [];
        setEntries(list);
        if (list.length > 0) setActiveSha((prev) => prev ?? list[0].sha);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load history');
      setEntries([]);
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // The History button lives in the note header at the top of the main
  // column, but the panel renders below the full note body — for long
  // notes that's offscreen, so clicking History appears to do nothing.
  // Scroll the panel into view on mount so the user sees it open.
  useEffect(() => {
    panelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const active = useMemo(
    () => entries.find((e) => e.sha === activeSha) ?? null,
    [entries, activeSha],
  );

  const handleRevert = useCallback(async () => {
    if (!active) return;
    if (!confirm(`Revert ${path} to ${active.shortSha}? A new commit will be made on top of HEAD with the historical content.`))
      return;
    setReverting(true);
    setRevertError(null);
    try {
      const { data, errors } = await graphqlRequest<{ revertNote: RevertResult }>(
        REVERT_NOTE,
        { path, sha: active.sha },
      );
      if (errors?.length) {
        setRevertError(errors.map((e) => e.message).join('; '));
        return;
      }
      const result = data?.revertNote;
      if (!result) {
        setRevertError('Empty response from server');
        return;
      }
      switch (result.kind) {
        case 'OK':
          if (result.commitSha) onReverted?.(result.commitSha);
          await refresh();
          break;
        case 'NOOP':
          setRevertError('Already at this revision (no commit made).');
          break;
        case 'NOT_FOUND':
        case 'AUTO_MANAGED':
        case 'INVALID':
          setRevertError(result.reason ?? `Revert failed (${result.kind})`);
          break;
      }
    } catch (err) {
      setRevertError(err instanceof Error ? err.message : 'Revert failed');
    } finally {
      setReverting(false);
    }
  }, [active, path, onReverted, refresh]);

  return (
    <div ref={panelRef} className={styles.historyPanel}>
      <div className={styles.historyHeader}>
        <strong>History</strong>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <button type="button" className={styles.btnSecondary} onClick={refresh} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          {onClose && (
            <button type="button" className={styles.btnSecondary} onClick={onClose}>
              Close
            </button>
          )}
        </div>
      </div>

      {error && <div className={styles.toastError}>{error}</div>}

      {entries.length === 0 && !loading && !error ? (
        <div className={styles.spinnerWrap}>No commits found for this path.</div>
      ) : (
        <ul className={styles.historyList}>
          {entries.map((entry, idx) => {
            const isActive = entry.sha === activeSha;
            const isHead = idx === 0;
            return (
              <li
                key={entry.sha}
                className={`${styles.historyItem} ${isActive ? styles.historyItemActive : ''}`}
                onClick={() => setActiveSha(entry.sha)}
              >
                <div className={styles.historyItemHeader}>
                  <AuthorChip
                    name={entry.authorName}
                    email={entry.authorEmail}
                    title={`${entry.authorName} <${entry.authorEmail}>`}
                  />
                  <strong className={styles.historyItemSubject}>
                    {entry.message.split('\n')[0]}
                  </strong>
                  {isHead && (
                    <span className={styles.historyCurrentBadge}>current</span>
                  )}
                </div>
                <div className={styles.historyMeta}>
                  <span className={styles.historyShortSha}>{entry.shortSha}</span>
                  <span>{formatDate(entry.date)}</span>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {active && (
        <div>
          <div className={styles.historyHeader} style={{ marginTop: '0.75rem' }}>
            <div className={styles.historyActiveHeader}>
              <AuthorChip
                name={active.authorName}
                email={active.authorEmail}
                title={`${active.authorName} <${active.authorEmail}>`}
              />
              <strong>{active.shortSha}</strong>
              <span className={styles.historyMeta} style={{ display: 'inline', marginLeft: '0.5rem' }}>
                {active.authorName} · {formatDate(active.date)}
              </span>
            </div>
            {!isAutoManaged && entries.indexOf(active) > 0 && (
              <button
                type="button"
                className={styles.btnDanger}
                onClick={handleRevert}
                disabled={reverting}
              >
                {reverting ? 'Reverting…' : `Revert to ${active.shortSha}`}
              </button>
            )}
          </div>
          {revertError && <div className={styles.toastError}>{revertError}</div>}
          {active.diff ? (
            <div className={styles.historyDiff}>{colorizeDiff(active.diff)}</div>
          ) : (
            <div className={styles.historyDiff}>(no diff — likely a rename-only commit)</div>
          )}
        </div>
      )}
    </div>
  );
}

/** Visual chip with the committer's initials in a colored disc + their
 *  display name. Disc color is stable per email so the same author always
 *  shows the same hue in the History list. */
function AuthorChip({
  name,
  email,
  title,
}: {
  name: string;
  email: string;
  title?: string;
}) {
  const initials = authorInitials(name, email);
  const hue = stableHueFromString(email || name);
  return (
    <span className={styles.authorChip} title={title}>
      <span
        className={styles.authorChipAvatar}
        style={{
          background: `hsl(${hue} 65% 32%)`,
          color: `hsl(${hue} 80% 92%)`,
        }}
        aria-hidden="true"
      >
        {initials}
      </span>
      <span className={styles.authorChipName}>{name}</span>
    </span>
  );
}

function authorInitials(name: string, email: string): string {
  const source = (name || email.split('@')[0] || '?').trim();
  const parts = source.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

function stableHueFromString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h % 360;
}
