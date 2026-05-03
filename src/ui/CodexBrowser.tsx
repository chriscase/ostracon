'use client';

import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import CodexTree, { type CodexTreeNode, noteHref } from './CodexTree';
import CodexPreview, { type CodexNote } from './CodexPreview';
import CodexGraph from './CodexGraph';
import CodexSearch, { type CodexSearchHit } from './CodexSearch';
import CodexEditor from './CodexEditor';
import NewNoteDialog, { defaultNewNoteContent } from './NewNoteDialog';
import RenameDialog from './RenameDialog';
import DeleteConfirmDialog from './DeleteConfirmDialog';
import NewFolderDialog from './NewFolderDialog';
import RenameFolderDialog from './RenameFolderDialog';
import DeleteFolderConfirmDialog from './DeleteFolderConfirmDialog';
import CommandPalette, { type PaletteAction } from './CommandPalette';
import QuickOpen from './QuickOpen';
import KeyboardShortcutsHelp from './KeyboardShortcutsHelp';
import { useShortcuts, registerShortcutHelp } from './useKeyboardShortcuts';
import HistoryPanel from './HistoryPanel';
import FindReplaceDialog from './FindReplaceDialog';
import BulkActionBar from './BulkActionBar';
import { useCodexGraphqlRequest, useCodexNavigation } from './CodexAdapters';
import styles from './codex.module.css';

const MY_PREFS_QUERY = `
  query MyCodexPrefs {
    myCodexPrefs { recentPaths pinnedPaths updatedAt }
  }
`;

const PIN_NOTE = `
  mutation PinCodexNote($path: String!) {
    pinCodexNote(path: $path) { recentPaths pinnedPaths updatedAt }
  }
`;

const UNPIN_NOTE = `
  mutation UnpinCodexNote($path: String!) {
    unpinCodexNote(path: $path) { recentPaths pinnedPaths updatedAt }
  }
`;

const BUMP_RECENT = `
  mutation BumpCodexRecent($path: String!) {
    bumpCodexRecent(path: $path) { recentPaths pinnedPaths updatedAt }
  }
`;

interface CodexUserPrefs {
  recentPaths: string[];
  pinnedPaths: string[];
  updatedAt: string;
}

const MOVE_NOTE = `
  mutation MoveNote($oldPath: String!, $newParentPath: String!) {
    moveNote(oldPath: $oldPath, newParentPath: $newParentPath) {
      kind
      newPath
      reason
    }
  }
`;

const MOVE_FOLDER = `
  mutation MoveFolder($oldPath: String!, $newParentPath: String!) {
    moveFolder(oldPath: $oldPath, newParentPath: $newParentPath) {
      kind
      newPath
      renamedNotes
      reason
    }
  }
`;

interface MoveResult {
  kind: 'OK' | 'NOT_FOUND' | 'CONFLICT' | 'AUTO_MANAGED' | 'INVALID';
  newPath?: string | null;
  renamedNotes?: number | null;
  reason?: string | null;
}

const TREE_QUERY = `
  query VaultTree {
    vaultTree {
      ...TreeFields
      children {
        ...TreeFields
        children {
          ...TreeFields
          children {
            ...TreeFields
            children {
              ...TreeFields
              children {
                ...TreeFields
              }
            }
          }
        }
      }
    }
  }
  fragment TreeFields on CodexTreeNode {
    name
    path
    kind
    status
    isAutoManaged
  }
`;

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

export type CodexView = 'welcome' | 'note' | 'graph';

interface Props {
  view?: CodexView;
  selectedPath?: string;
  graphScope?: string;
  /** When true, the note view starts in editor mode (used by ?new=1 flow). */
  startInCreate?: boolean;
}

export default function CodexBrowser({
  view = 'welcome',
  selectedPath,
  graphScope,
  startInCreate = false,
}: Props) {
  const graphqlRequest = useCodexGraphqlRequest();
  const { Link, useRouter: useNavRouter } = useCodexNavigation();
  const router = useNavRouter();
  const [tree, setTree] = useState<CodexTreeNode | null>(null);
  const [note, setNote] = useState<CodexNote | null>(null);
  const [loadingTree, setLoadingTree] = useState(true);
  const [loadingNote, setLoadingNote] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchHits, setSearchHits] = useState<CodexSearchHit[] | null>(null);
  const [editing, setEditing] = useState<boolean>(false);
  const [newNoteOpen, setNewNoteOpen] = useState<boolean>(false);
  const [renameTarget, setRenameTarget] = useState<CodexTreeNode | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CodexTreeNode | null>(null);
  // null = closed; { parent: null } = create-at-root; { parent: node } = create-inside-folder.
  const [newFolderState, setNewFolderState] = useState<{ parent: CodexTreeNode | null } | null>(
    null,
  );
  const [renameFolderTarget, setRenameFolderTarget] = useState<CodexTreeNode | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<CodexTreeNode | null>(null);
  const [paletteOpen, setPaletteOpen] = useState<boolean>(false);
  const [quickOpenOpen, setQuickOpenOpen] = useState<boolean>(false);
  const [helpOpen, setHelpOpen] = useState<boolean>(false);
  const [historyOpen, setHistoryOpen] = useState<boolean>(false);
  const [findReplaceOpen, setFindReplaceOpen] = useState<boolean>(false);
  // Multi-select state (chriscase/abydonian#225). Notes only — folders excluded.
  const [multiSelected, setMultiSelected] = useState<Set<string>>(() => new Set());
  const lastMultiClickRef = useRef<string | null>(null);
  // Per-user prefs (chriscase/abydonian#228). null = not yet loaded.
  const [prefs, setPrefs] = useState<CodexUserPrefs | null>(null);
  const [pinnedSidebarOpen, setPinnedSidebarOpen] = useState<boolean>(true);
  const [toast, setToast] = useState<string | null>(null);

  const refreshTree = useCallback(async () => {
    try {
      const { data, errors } = await graphqlRequest<{ vaultTree: CodexTreeNode }>(TREE_QUERY);
      if (errors?.length) {
        setError(errors.map((e) => e.message).join('; '));
      } else {
        setTree(data?.vaultTree ?? null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load vault tree');
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refreshTree();
      if (!cancelled) setLoadingTree(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshTree]);

  useEffect(() => {
    if (view !== 'note' || !selectedPath) {
      setNote(null);
      setEditing(false);
      return;
    }
    let cancelled = false;
    setLoadingNote(true);
    (async () => {
      try {
        const { data, errors } = await graphqlRequest<{ vaultNote: CodexNote | null }>(
          NOTE_QUERY,
          { path: selectedPath },
        );
        if (cancelled) return;
        if (errors?.length) {
          setError(errors.map((e) => e.message).join('; '));
          setNote(null);
        } else {
          setNote(data?.vaultNote ?? null);
          setError(null);
          // ?new=1 flow: file might not exist yet; we render the editor in
          // create mode with a synthesized "note" shape.
          if (!data?.vaultNote && startInCreate) {
            setEditing(true);
          } else {
            setEditing(false);
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load note');
      } finally {
        if (!cancelled) setLoadingNote(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view, selectedPath, startInCreate]);

  const onSearchResults = useCallback((hits: CodexSearchHit[] | null) => {
    setSearchHits(hits);
  }, []);

  const handleRenamed = useCallback(
    async (newPath: string, rewrittenCount: number) => {
      setRenameTarget(null);
      const oldPath = selectedPath;
      // Re-fetch the tree so the new path appears (and the old one disappears).
      await refreshTree();
      setToast(
        `Renamed${rewrittenCount > 0 ? ` · ${rewrittenCount} backlink${rewrittenCount === 1 ? '' : 's'} updated` : ''}`,
      );
      // Auto-clear the toast after a short delay.
      setTimeout(() => setToast(null), 3500);
      // If the user was viewing the renamed note, navigate to its new path.
      if (oldPath && oldPath === renameTarget?.path) {
        router.push(noteHref(newPath));
      }
    },
    [selectedPath, refreshTree, router, renameTarget?.path],
  );

  const handleDeleted = useCallback(
    async (orphanCount: number) => {
      const deletedPath = deleteTarget?.path;
      setDeleteTarget(null);
      await refreshTree();
      setToast(
        `Deleted${orphanCount > 0 ? ` · ${orphanCount} note${orphanCount === 1 ? '' : 's'} now have orphan link${orphanCount === 1 ? '' : 's'}` : ''}`,
      );
      setTimeout(() => setToast(null), 4000);
      // If the user was viewing the deleted note, send them back to the
      // welcome screen — there's nothing to render anymore.
      if (selectedPath && selectedPath === deletedPath) {
        router.push('/admin/codex');
      }
    },
    [deleteTarget?.path, refreshTree, router, selectedPath],
  );

  const handleFolderCreated = useCallback(
    async (path: string) => {
      setNewFolderState(null);
      await refreshTree();
      setToast(`Created folder ${path}`);
      setTimeout(() => setToast(null), 3000);
    },
    [refreshTree],
  );

  const handleFolderRenamed = useCallback(
    async (newPath: string, renamedNotes: number, rewrittenCount: number) => {
      const oldPath = renameFolderTarget?.path;
      setRenameFolderTarget(null);
      await refreshTree();
      setToast(
        `Renamed folder · ${renamedNotes} note${renamedNotes === 1 ? '' : 's'} moved` +
          (rewrittenCount > 0
            ? ` · ${rewrittenCount} backlink${rewrittenCount === 1 ? '' : 's'} updated`
            : ''),
      );
      setTimeout(() => setToast(null), 4000);
      // If the user was viewing a note inside the renamed folder, redirect to
      // its new location.
      if (oldPath && selectedPath?.startsWith(oldPath + '/')) {
        const suffix = selectedPath.slice(oldPath.length);
        router.push(noteHref(newPath + suffix));
      }
    },
    [renameFolderTarget?.path, refreshTree, router, selectedPath],
  );

  const handleFolderDeleted = useCallback(
    async (deletedCount: number, orphanCount: number) => {
      const deletedPath = deleteFolderTarget?.path;
      setDeleteFolderTarget(null);
      await refreshTree();
      setToast(
        `Deleted folder · ${deletedCount} note${deletedCount === 1 ? '' : 's'}` +
          (orphanCount > 0
            ? ` · ${orphanCount} note${orphanCount === 1 ? '' : 's'} now have orphan link${orphanCount === 1 ? '' : 's'}`
            : ''),
      );
      setTimeout(() => setToast(null), 4500);
      if (selectedPath && deletedPath && selectedPath.startsWith(deletedPath + '/')) {
        router.push('/admin/codex');
      }
    },
    [deleteFolderTarget?.path, refreshTree, router, selectedPath],
  );

  const handleMove = useCallback(
    async (source: CodexTreeNode, destFolderPath: string) => {
      try {
        if (source.kind === 'NOTE') {
          const { data, errors } = await graphqlRequest<{ moveNote: MoveResult }>(
            MOVE_NOTE,
            { oldPath: source.path, newParentPath: destFolderPath },
          );
          if (errors?.length || data?.moveNote.kind !== 'OK') {
            const reason =
              errors?.map((e) => e.message).join('; ') ??
              data?.moveNote.reason ??
              'Move failed';
            setToast(`Move failed: ${reason}`);
            setTimeout(() => setToast(null), 4000);
            return;
          }
          const finalPath = data.moveNote.newPath ?? '';
          await refreshTree();
          setToast(`Moved ${source.name} → ${destFolderPath}`);
          setTimeout(() => setToast(null), 3000);
          if (selectedPath === source.path && finalPath) {
            router.push(noteHref(finalPath));
          }
        } else {
          const { data, errors } = await graphqlRequest<{ moveFolder: MoveResult }>(
            MOVE_FOLDER,
            { oldPath: source.path, newParentPath: destFolderPath },
          );
          if (errors?.length || data?.moveFolder.kind !== 'OK') {
            const reason =
              errors?.map((e) => e.message).join('; ') ??
              data?.moveFolder.reason ??
              'Move failed';
            setToast(`Move failed: ${reason}`);
            setTimeout(() => setToast(null), 4000);
            return;
          }
          const finalPath = data.moveFolder.newPath ?? '';
          const renamedNotes = data.moveFolder.renamedNotes ?? 0;
          await refreshTree();
          setToast(
            `Moved folder ${source.name} → ${destFolderPath}${renamedNotes > 0 ? ` · ${renamedNotes} note${renamedNotes === 1 ? '' : 's'}` : ''}`,
          );
          setTimeout(() => setToast(null), 3500);
          if (selectedPath?.startsWith(source.path + '/') && finalPath) {
            const suffix = selectedPath.slice(source.path.length);
            router.push(noteHref(finalPath + suffix));
          }
        }
      } catch (err) {
        setToast(`Move failed: ${err instanceof Error ? err.message : 'unknown error'}`);
        setTimeout(() => setToast(null), 4000);
      }
    },
    [refreshTree, router, selectedPath],
  );

  const handleSaved = useCallback(() => {
    setEditing(false);
    if (selectedPath) {
      // Re-fetch note and tree so the preview reflects the new content + the
      // tree picks up newly-created files.
      void (async () => {
        await refreshTree();
        const { data } = await graphqlRequest<{ vaultNote: CodexNote | null }>(NOTE_QUERY, {
          path: selectedPath,
        });
        setNote(data?.vaultNote ?? null);
      })();
    }
    // Strip the ?new=1 query param if it's still on the URL.
    if (selectedPath && startInCreate) {
      router.replace(noteHref(selectedPath));
    }
  }, [selectedPath, refreshTree, router, startInCreate]);

  // Helper: walk the tree to find the CodexTreeNode for the currently-
  // selected path, so palette actions like "Rename current note" have a node
  // to operate on.
  const currentNode = useMemo<CodexTreeNode | null>(() => {
    if (!selectedPath || !tree) return null;
    const stack: CodexTreeNode[] = [tree];
    while (stack.length) {
      const n = stack.pop()!;
      if (n.path === selectedPath) return n;
      if (n.children) stack.push(...n.children);
    }
    return null;
  }, [selectedPath, tree]);

  // ─── Cmd+K palette actions ────────────────────────────────────────────
  const paletteActions = useMemo<PaletteAction[]>(() => {
    const list: PaletteAction[] = [
      {
        id: 'new-note',
        label: 'New note…',
        category: 'Vault',
        keywords: ['create', 'add'],
        run: () => setNewNoteOpen(true),
      },
      {
        id: 'new-folder',
        label: 'New folder at root…',
        category: 'Vault',
        keywords: ['create', 'add', 'directory', 'mkdir'],
        run: () => setNewFolderState({ parent: null }),
      },
      {
        id: 'quick-open',
        label: 'Quick open note…',
        category: 'Navigation',
        keywords: ['find', 'search', 'jump'],
        run: () => setQuickOpenOpen(true),
      },
      {
        id: 'view-tree',
        label: 'Show tree view',
        category: 'Navigation',
        run: () => router.push('/admin/codex'),
      },
      {
        id: 'view-graph',
        label: 'Show graph view',
        category: 'Navigation',
        run: () => router.push('/admin/codex/graph'),
      },
      {
        id: 'show-help',
        label: 'Keyboard shortcuts…',
        category: 'Help',
        keywords: ['?', 'cheatsheet'],
        run: () => setHelpOpen(true),
      },
      {
        id: 'find-replace',
        label: 'Find &amp; replace across vault…',
        category: 'Vault',
        keywords: ['search', 'sub', 'sed', 'rewrite'],
        run: () => setFindReplaceOpen(true),
      },
      {
        id: 'view-tags',
        label: 'Browse tags',
        category: 'Navigation',
        keywords: ['tag', 'taxonomy'],
        run: () => router.push('/admin/codex/tags'),
      },
    ];
    if (currentNode && currentNode.kind === 'NOTE' && !currentNode.isAutoManaged) {
      list.push(
        {
          id: 'rename-current',
          label: `Rename current note (${currentNode.name})…`,
          category: 'Note',
          keywords: ['mv', 'move'],
          run: () => setRenameTarget(currentNode),
        },
        {
          id: 'delete-current',
          label: `Delete current note (${currentNode.name})…`,
          category: 'Note',
          keywords: ['rm', 'remove'],
          run: () => setDeleteTarget(currentNode),
        },
        {
          id: 'edit-current',
          label: `Edit current note (${currentNode.name})`,
          category: 'Note',
          run: () => setEditing(true),
        },
      );
      // Pin / unpin toggle, depending on current state.
      if (prefs?.pinnedPaths.includes(currentNode.path)) {
        list.push({
          id: 'unpin-current',
          label: `Unpin current note (${currentNode.name})`,
          category: 'Note',
          keywords: ['favorite'],
          run: () => void unpinNote(currentNode.path),
        });
      } else {
        list.push({
          id: 'pin-current',
          label: `Pin current note (${currentNode.name})`,
          category: 'Note',
          keywords: ['favorite', 'star'],
          run: () => void pinNote(currentNode.path),
        });
      }
    }
    return list;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pin/unpin closures are stable
  }, [currentNode, router, prefs]);

  // ─── Global keyboard shortcuts ────────────────────────────────────────
  useShortcuts({
    'mod+k': (e) => {
      e.preventDefault();
      setPaletteOpen((v) => !v);
    },
    'mod+p': (e) => {
      e.preventDefault();
      setQuickOpenOpen((v) => !v);
    },
    'mod+shift+f': (e) => {
      e.preventDefault();
      setFindReplaceOpen((v) => !v);
    },
    'mod+/': (e) => {
      e.preventDefault();
      setHelpOpen((v) => !v);
    },
    'mod+shift+/': (e) => {
      e.preventDefault();
      setHelpOpen((v) => !v);
    },
    'esc': (e) => {
      // Close any open palette/dialog. Only acts if one is open — falls
      // through silently otherwise.
      if (paletteOpen) {
        e.preventDefault();
        setPaletteOpen(false);
      } else if (quickOpenOpen) {
        e.preventDefault();
        setQuickOpenOpen(false);
      } else if (helpOpen) {
        e.preventDefault();
        setHelpOpen(false);
      } else if (findReplaceOpen) {
        e.preventDefault();
        setFindReplaceOpen(false);
      } else if (multiSelected.size > 0) {
        e.preventDefault();
        setMultiSelected(new Set());
      }
    },
  });

  // Register entries for the Cmd+? help dialog.
  useEffect(() => {
    return registerShortcutHelp([
      { combo: 'mod+s', label: 'Save current note', category: 'Editor' },
      { combo: 'mod+k', label: 'Open command palette', category: 'Navigation' },
      { combo: 'mod+p', label: 'Quick open note', category: 'Navigation' },
      { combo: 'mod+shift+f', label: 'Find &amp; replace across vault', category: 'Vault' },
      { combo: 'mod+/', label: 'Show this help', category: 'Help' },
      { combo: 'F2', label: 'Rename focused note', category: 'Tree' },
    ]);
  }, []);

  // ─── Per-user prefs (chriscase/abydonian#228) ──────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await graphqlRequest<{ myCodexPrefs: CodexUserPrefs }>(
          MY_PREFS_QUERY,
        );
        if (!cancelled) setPrefs(data?.myCodexPrefs ?? null);
      } catch {
        // Non-fatal — sidebar just won't show recents/pinned.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Bump-recent on every note view (best-effort; failures are silent).
  useEffect(() => {
    if (view !== 'note' || !selectedPath) return;
    let cancelled = false;
    (async () => {
      try {
        const { data } = await graphqlRequest<{ bumpCodexRecent: CodexUserPrefs }>(
          BUMP_RECENT,
          { path: selectedPath },
        );
        if (!cancelled && data?.bumpCodexRecent) setPrefs(data.bumpCodexRecent);
      } catch {
        // Best-effort.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [view, selectedPath]);

  const pinNote = useCallback(async (path: string) => {
    try {
      const { data } = await graphqlRequest<{ pinCodexNote: CodexUserPrefs }>(
        PIN_NOTE,
        { path },
      );
      if (data?.pinCodexNote) setPrefs(data.pinCodexNote);
      setToast(`Pinned ${path.split('/').pop()}`);
      setTimeout(() => setToast(null), 2500);
    } catch (err) {
      setToast(`Pin failed: ${err instanceof Error ? err.message : 'unknown'}`);
      setTimeout(() => setToast(null), 4000);
    }
  }, []);

  const unpinNote = useCallback(async (path: string) => {
    try {
      const { data } = await graphqlRequest<{ unpinCodexNote: CodexUserPrefs }>(
        UNPIN_NOTE,
        { path },
      );
      if (data?.unpinCodexNote) setPrefs(data.unpinCodexNote);
      setToast(`Unpinned ${path.split('/').pop()}`);
      setTimeout(() => setToast(null), 2500);
    } catch (err) {
      setToast(`Unpin failed: ${err instanceof Error ? err.message : 'unknown'}`);
      setTimeout(() => setToast(null), 4000);
    }
  }, []);

  // ─── Multi-select handler (chriscase/abydonian#225) ───────────────────
  const orderedNotePaths = useMemo<string[]>(() => {
    // Pre-compute the depth-first order of every note in the tree so
    // shift-range selection can compute "all notes between A and B" without
    // re-walking on every click.
    if (!tree) return [];
    const out: string[] = [];
    const stack: CodexTreeNode[] = [tree];
    while (stack.length) {
      const n = stack.shift()!;
      if (n.kind === 'NOTE') out.push(n.path);
      if (n.children) stack.unshift(...n.children);
    }
    return out;
  }, [tree]);

  const handleMultiSelectToggle = useCallback(
    (path: string, modifiers: { meta: boolean; shift: boolean }) => {
      setMultiSelected((prev) => {
        const next = new Set(prev);
        if (modifiers.shift && lastMultiClickRef.current) {
          // Range select from anchor to current.
          const anchor = lastMultiClickRef.current;
          const a = orderedNotePaths.indexOf(anchor);
          const b = orderedNotePaths.indexOf(path);
          if (a >= 0 && b >= 0) {
            const [lo, hi] = a < b ? [a, b] : [b, a];
            for (let i = lo; i <= hi; i++) next.add(orderedNotePaths[i]);
          } else {
            next.add(path);
          }
        } else {
          // Toggle individual.
          if (next.has(path)) next.delete(path);
          else next.add(path);
        }
        lastMultiClickRef.current = path;
        return next;
      });
    },
    [orderedNotePaths, lastMultiClickRef],
  );

  const showCreateMode =
    view === 'note' && selectedPath && !loadingNote && !note && startInCreate;
  const showEditor = view === 'note' && (editing || showCreateMode);

  const titleFromPath = (rel: string) => rel.split('/').pop()?.replace(/\.md$/, '') ?? 'New note';

  return (
    <div className={styles.layout}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarTopBar}>
          <Link
            href="/admin/codex"
            className={`${styles.viewTab} ${view !== 'graph' ? styles.viewTabActive : ''}`}
          >
            Tree
          </Link>
          <Link
            href="/admin/codex/graph"
            className={`${styles.viewTab} ${view === 'graph' ? styles.viewTabActive : ''}`}
          >
            Graph
          </Link>
          <Link href="/admin/codex/tags" className={styles.viewTab}>
            Tags
          </Link>
        </div>

        <CodexSearch onResults={onSearchResults} />

        <button
          type="button"
          className={styles.btnPrimary}
          style={{ width: '100%', marginBottom: '0.25rem' }}
          onClick={() => setNewNoteOpen(true)}
        >
          + New note
        </button>
        <button
          type="button"
          className={styles.btnSecondary}
          style={{ width: '100%', marginBottom: '0.5rem' }}
          onClick={() => setNewFolderState({ parent: null })}
        >
          + New folder
        </button>

        {prefs && (prefs.pinnedPaths.length > 0 || prefs.recentPaths.length > 0) && (
          <div className={styles.prefsSection}>
            <button
              type="button"
              className={styles.prefsToggle}
              onClick={() => setPinnedSidebarOpen((v) => !v)}
            >
              {pinnedSidebarOpen ? '▾' : '▸'} Pinned &amp; recents
            </button>
            {pinnedSidebarOpen && (
              <>
                {prefs.pinnedPaths.length > 0 && (
                  <div className={styles.prefsGroup}>
                    <div className={styles.prefsGroupHeader}>Pinned</div>
                    <ul className={styles.prefsList}>
                      {prefs.pinnedPaths.map((p) => (
                        <li key={p}>
                          <Link href={noteHref(p)} className={styles.prefsRow}>
                            <span className={styles.prefsRowName}>
                              {p.split('/').pop()?.replace(/\.md$/, '')}
                            </span>
                            <span className={styles.prefsRowFolder}>
                              {p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {prefs.recentPaths.length > 0 && (
                  <div className={styles.prefsGroup}>
                    <div className={styles.prefsGroupHeader}>Recents</div>
                    <ul className={styles.prefsList}>
                      {prefs.recentPaths.map((p) => (
                        <li key={p}>
                          <Link href={noteHref(p)} className={styles.prefsRow}>
                            <span className={styles.prefsRowName}>
                              {p.split('/').pop()?.replace(/\.md$/, '')}
                            </span>
                            <span className={styles.prefsRowFolder}>
                              {p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        <BulkActionBar
          selectedPaths={[...multiSelected]}
          onClearSelection={() => setMultiSelected(new Set())}
          onBatchComplete={async (summary) => {
            await refreshTree();
            setToast(summary);
            setTimeout(() => setToast(null), 4500);
          }}
        />

        <h3 className={styles.sidebarHeader}>
          <span>{searchHits === null ? 'AbydosCodex' : 'Search results'}</span>
          {searchHits === null && tree?.children && (
            <span style={{ fontWeight: 400 }}>{countNotes(tree)} notes</span>
          )}
          {searchHits !== null && (
            <span style={{ fontWeight: 400 }}>{searchHits.length} hits</span>
          )}
        </h3>

        {searchHits === null ? (
          loadingTree ? (
            <div className={styles.spinnerWrap}>Loading vault…</div>
          ) : (
            <CodexTree
              root={tree}
              selectedPath={selectedPath}
              onRename={(node) => setRenameTarget(node)}
              onDelete={(node) => setDeleteTarget(node)}
              onCreateFolder={(parent) => setNewFolderState({ parent })}
              onRenameFolder={(node) => setRenameFolderTarget(node)}
              onDeleteFolder={(node) => setDeleteFolderTarget(node)}
              onMove={handleMove}
              multiSelect={{
                selected: multiSelected,
                onToggle: handleMultiSelectToggle,
              }}
            />
          )
        ) : searchHits.length === 0 ? (
          <div className={styles.spinnerWrap}>No matches</div>
        ) : (
          <ul className={styles.searchResultsList}>
            {searchHits.map((hit) => (
              <li key={hit.note.path}>
                <Link
                  href={noteHref(hit.note.path)}
                  className={`${styles.searchResultRow} ${
                    selectedPath === hit.note.path ? styles.noteRowActive : ''
                  }`}
                >
                  <span>{hit.note.title}</span>
                  <span className={styles.searchResultMeta}>
                    {hit.note.folder} · {hit.matchedOn}
                  </span>
                  {hit.excerpt && <span className={styles.searchResultExcerpt}>{hit.excerpt}</span>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <main className={styles.main}>
        {error && <div className={styles.error}>{error}</div>}
        {!error && view === 'welcome' && <Welcome />}
        {!error && view === 'graph' && <CodexGraph scope={graphScope} />}
        {!error && view === 'note' && loadingNote && (
          <div className={styles.spinnerWrap}>Loading note…</div>
        )}
        {!error && showEditor && selectedPath && (
          <CodexEditor
            path={selectedPath}
            initialContent={note?.content ?? defaultNewNoteContent(titleFromPath(selectedPath))}
            baseSha={note?.sha ?? null}
            isAutoManaged={note?.isAutoManaged ?? false}
            onCancel={() => {
              setEditing(false);
              if (startInCreate) router.push('/admin/codex');
            }}
            onSaved={handleSaved}
          />
        )}
        {!error && view === 'note' && !loadingNote && note && !showEditor && (
          <>
            <CodexPreview
              note={note}
              canEdit
              onEdit={() => setEditing(true)}
              onShowHistory={() => setHistoryOpen((v) => !v)}
            />
            {historyOpen && (
              <HistoryPanel
                path={note.path}
                isAutoManaged={note.isAutoManaged}
                onClose={() => setHistoryOpen(false)}
                onReverted={async () => {
                  // Re-fetch the note so the preview reflects the reverted content.
                  const { data } = await graphqlRequest<{ vaultNote: CodexNote | null }>(
                    NOTE_QUERY,
                    { path: note.path },
                  );
                  setNote(data?.vaultNote ?? null);
                  await refreshTree();
                  setToast('Reverted to selected revision');
                  setTimeout(() => setToast(null), 3000);
                }}
              />
            )}
          </>
        )}
        {!error && view === 'note' && !loadingNote && !note && !showCreateMode && selectedPath && (
          <div className={styles.error}>Note not found: {selectedPath}</div>
        )}
      </main>

      <NewNoteDialog open={newNoteOpen} onClose={() => setNewNoteOpen(false)} />
      {renameTarget && (
        <RenameDialog
          open
          oldPath={renameTarget.path}
          onClose={() => setRenameTarget(null)}
          onRenamed={handleRenamed}
        />
      )}
      {deleteTarget && (
        <DeleteConfirmDialog
          open
          path={deleteTarget.path}
          onClose={() => setDeleteTarget(null)}
          onDeleted={handleDeleted}
        />
      )}
      {newFolderState && (
        <NewFolderDialog
          open
          parentPath={newFolderState.parent?.path}
          onClose={() => setNewFolderState(null)}
          onCreated={handleFolderCreated}
        />
      )}
      {renameFolderTarget && (
        <RenameFolderDialog
          open
          oldPath={renameFolderTarget.path}
          onClose={() => setRenameFolderTarget(null)}
          onRenamed={handleFolderRenamed}
        />
      )}
      {deleteFolderTarget && (
        <DeleteFolderConfirmDialog
          open
          path={deleteFolderTarget.path}
          onClose={() => setDeleteFolderTarget(null)}
          onDeleted={handleFolderDeleted}
        />
      )}
      <CommandPalette
        open={paletteOpen}
        actions={paletteActions}
        onClose={() => setPaletteOpen(false)}
      />
      <QuickOpen open={quickOpenOpen} onClose={() => setQuickOpenOpen(false)} />
      <KeyboardShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
      <FindReplaceDialog
        open={findReplaceOpen}
        onClose={() => setFindReplaceOpen(false)}
        onApplied={async (totalReplacements, filesChanged) => {
          await refreshTree();
          setToast(
            `Replaced ${totalReplacements} occurrence${totalReplacements === 1 ? '' : 's'} across ${filesChanged} file${filesChanged === 1 ? '' : 's'}`,
          );
          setTimeout(() => setToast(null), 5000);
        }}
      />
      {toast && <div className={styles.toastOk} style={{ position: 'fixed', bottom: '1rem', right: '1rem', zIndex: 1100 }}>{toast}</div>}
    </div>
  );
}

function countNotes(node: CodexTreeNode): number {
  let n = node.kind === 'NOTE' ? 1 : 0;
  for (const c of node.children ?? []) n += countNotes(c);
  return n;
}

function Welcome() {
  const { Link } = useCodexNavigation();
  return (
    <div className={styles.welcome}>
      <h2>AbydosCodex</h2>
      <p>
        The cross-product knowledge vault. Browse by folder on the left, search by title, tag,
        or body content; switch to <Link href="/admin/codex/graph">Graph</Link> for the link
        map. Click any note to read; click <strong>Edit</strong> in the note header to update
        it (changes commit + push back to the vault repo).
      </p>
      <ul>
        <li><strong>20 - Products</strong> — current state of each product</li>
        <li><strong>30 - Architecture</strong> — cross-product technical patterns</li>
        <li><strong>40 - Concepts</strong> — domain knowledge (karaoke, audio, sync, …)</li>
        <li><strong>70 - Journals</strong> — repo journals (auto-mined nightly; read-only here)</li>
        <li><strong>80 - Daily</strong> — daily working journals</li>
      </ul>
    </div>
  );
}
