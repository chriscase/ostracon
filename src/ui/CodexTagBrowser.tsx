'use client';

// Tag browser (chriscase/abydonian#227).
//
// Lists every tag in the vault ranked by usage. Click a tag to expand the
// list of notes that use it; rename/delete from there.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useCodexGraphqlRequest, useCodexNavigation } from './CodexAdapters';
import { noteHref } from './CodexTree';
import styles from './codex.module.css';

const TAGS_QUERY = `
  query VaultTags {
    vaultTags { tag count notes }
  }
`;

const RENAME_TAG = `
  mutation RenameTag($oldTag: String!, $newTag: String!) {
    renameTag(oldTag: $oldTag, newTag: $newTag) {
      kind commitSha filesChanged reason
    }
  }
`;

const DELETE_TAG = `
  mutation DeleteTag($tag: String!) {
    deleteTag(tag: $tag) {
      kind commitSha filesChanged reason
    }
  }
`;

interface TagSummary {
  tag: string;
  count: number;
  notes: string[];
}

interface MutationResult {
  kind: 'OK' | 'INVALID' | 'NOOP';
  commitSha?: string | null;
  filesChanged?: string[] | null;
  reason?: string | null;
}

export default function CodexTagBrowser() {
  const graphqlRequest = useCodexGraphqlRequest();
  const { Link } = useCodexNavigation();
  const [tags, setTags] = useState<TagSummary[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>('');
  const [activeTag, setActiveTag] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data, errors } = await graphqlRequest<{ vaultTags: TagSummary[] }>(TAGS_QUERY);
      if (errors?.length) {
        setError(errors.map((e) => e.message).join('; '));
        setTags([]);
      } else {
        setTags(data?.vaultTags ?? []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load tags');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return tags;
    return tags.filter((t) => t.tag.toLowerCase().includes(q));
  }, [tags, filter]);

  const active = useMemo(
    () => tags.find((t) => t.tag === activeTag) ?? null,
    [tags, activeTag],
  );

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  }, []);

  async function handleRename(oldTag: string) {
    const newTag = prompt(`Rename #${oldTag} to:`)?.trim();
    if (!newTag || newTag === oldTag) return;
    setBusy(true);
    try {
      const { data, errors } = await graphqlRequest<{ renameTag: MutationResult }>(
        RENAME_TAG,
        { oldTag, newTag },
      );
      if (errors?.length) {
        showToast(`Rename failed: ${errors.map((e) => e.message).join('; ')}`);
        return;
      }
      const r = data?.renameTag;
      if (!r) return;
      if (r.kind === 'OK') {
        showToast(
          `Renamed #${oldTag} → #${newTag} across ${r.filesChanged?.length ?? 0} note${(r.filesChanged?.length ?? 0) === 1 ? '' : 's'}`,
        );
        if (activeTag === oldTag) setActiveTag(newTag);
        await refresh();
      } else {
        showToast(r.reason ?? `Rename ${r.kind}`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(tagName: string) {
    if (
      !confirm(
        `Remove tag #${tagName} from every note that uses it? This is one git commit; auto-managed notes are skipped.`,
      )
    )
      return;
    setBusy(true);
    try {
      const { data, errors } = await graphqlRequest<{ deleteTag: MutationResult }>(
        DELETE_TAG,
        { tag: tagName },
      );
      if (errors?.length) {
        showToast(`Delete failed: ${errors.map((e) => e.message).join('; ')}`);
        return;
      }
      const r = data?.deleteTag;
      if (!r) return;
      if (r.kind === 'OK') {
        showToast(
          `Deleted #${tagName} from ${r.filesChanged?.length ?? 0} note${(r.filesChanged?.length ?? 0) === 1 ? '' : 's'}`,
        );
        if (activeTag === tagName) setActiveTag(null);
        await refresh();
      } else {
        showToast(r.reason ?? `Delete ${r.kind}`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.tagBrowserLayout}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarTopBar}>
          <Link href="/admin/codex" className={styles.viewTab}>
            Tree
          </Link>
          <Link href="/admin/codex/graph" className={styles.viewTab}>
            Graph
          </Link>
          <Link href="/admin/codex/tags" className={`${styles.viewTab} ${styles.viewTabActive}`}>
            Tags
          </Link>
        </div>
        <input
          type="text"
          className={styles.modalInput}
          style={{ width: '100%', marginBottom: '0.5rem' }}
          placeholder="Filter tags…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <h3 className={styles.sidebarHeader}>
          <span>Tags</span>
          <span style={{ fontWeight: 400 }}>{filtered.length} / {tags.length}</span>
        </h3>
        {loading ? (
          <div className={styles.spinnerWrap}>Loading…</div>
        ) : error ? (
          <div className={styles.toastError}>{error}</div>
        ) : filtered.length === 0 ? (
          <div className={styles.spinnerWrap}>No tags{filter ? ' match the filter' : ' in vault'}.</div>
        ) : (
          <ul className={styles.tagList}>
            {filtered.map((t) => (
              <li key={t.tag}>
                <button
                  type="button"
                  className={`${styles.tagListRow} ${activeTag === t.tag ? styles.tagListRowActive : ''}`}
                  onClick={() => setActiveTag(t.tag)}
                >
                  <span className={styles.tag}>#{t.tag}</span>
                  <span className={styles.tagListCount}>{t.count}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <main className={styles.main}>
        {!active ? (
          <div className={styles.welcome}>
            <h2>Tag browser</h2>
            <p>Click a tag on the left to see the notes that use it. From there, rename the tag (rewrites every note&apos;s frontmatter) or delete it (removes from every note). Auto-managed notes are skipped by both operations.</p>
            <ul>
              <li>Total tags in vault: <strong>{tags.length}</strong></li>
              <li>Total tagged notes (sum of counts): <strong>{tags.reduce((acc, t) => acc + t.count, 0)}</strong></li>
            </ul>
          </div>
        ) : (
          <div>
            <div className={styles.noteHeader}>
              <h2 style={{ margin: 0 }}>#{active.tag}</h2>
              <span className={styles.tagListCount}>{active.count} note{active.count === 1 ? '' : 's'}</span>
              <div style={{ marginLeft: 'auto', display: 'flex', gap: '0.5rem' }}>
                <button
                  type="button"
                  className={styles.btnSecondary}
                  onClick={() => handleRename(active.tag)}
                  disabled={busy}
                >
                  Rename…
                </button>
                <button
                  type="button"
                  className={styles.btnDanger}
                  onClick={() => handleDelete(active.tag)}
                  disabled={busy}
                >
                  Delete…
                </button>
              </div>
            </div>
            <ul className={styles.tagNoteList}>
              {active.notes.map((p) => (
                <li key={p}>
                  <Link href={noteHref(p)}>{p}</Link>
                </li>
              ))}
            </ul>
          </div>
        )}
      </main>

      {toast && (
        <div className={styles.toastOk} style={{ position: 'fixed', bottom: '1rem', right: '1rem', zIndex: 1100 }}>
          {toast}
        </div>
      )}
    </div>
  );
}
