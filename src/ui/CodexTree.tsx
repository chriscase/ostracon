'use client';

import { memo, useState, useMemo, useCallback } from 'react';
import { useCodexNavigation } from './CodexAdapters';
import styles from './codex.module.css';

export interface CodexTreeNode {
  name: string;
  path: string;
  kind: 'FOLDER' | 'NOTE';
  status?: string | null;
  isAutoManaged?: boolean | null;
  children?: CodexTreeNode[];
}

interface Props {
  root: CodexTreeNode | null;
  selectedPath?: string;
  /** Optional callback fired when a note's "Rename" context-menu item is chosen. */
  onRename?: (node: CodexTreeNode) => void;
  /** Optional callback fired when a note's "Delete" context-menu item is chosen. */
  onDelete?: (node: CodexTreeNode) => void;
  /** Optional callback fired when a folder's "+ New folder here" item is chosen.
   *  Pass `null` to create at the vault root. */
  onCreateFolder?: (parent: CodexTreeNode | null) => void;
  /** Optional callback fired when a folder's "Rename folder" item is chosen. */
  onRenameFolder?: (node: CodexTreeNode) => void;
  /** Optional callback fired when a folder's "Delete folder" item is chosen. */
  onDeleteFolder?: (node: CodexTreeNode) => void;
  /** Optional callback fired when a node is dragged into a folder via drag/drop. */
  onMove?: (source: CodexTreeNode, destFolderPath: string) => void;
  /** Multi-select state (chriscase/abydonian#225). When provided, note rows
   *  respect Cmd/Shift-click to toggle/range-select. The parent owns the
   *  set so it can render the BulkActionBar above the tree. */
  multiSelect?: {
    selected: Set<string>;
    onToggle: (
      path: string,
      modifiers: { shift: boolean; meta: boolean },
    ) => void;
  };
}

function statusClass(status: string | null | undefined): string | null {
  switch ((status ?? '').toLowerCase()) {
    case 'active':
      return styles.statusActive;
    case 'paused':
      return styles.statusPaused;
    case 'archived':
      return styles.statusArchived;
    default:
      return null;
  }
}

// Encode a vault relative path for the catch-all dynamic route.
// The path uses OS separators; we normalize to "/" and let Next encode
// individual segments.
function noteHref(relPath: string): string {
  // Strip the .md extension before encoding. The next-intl middleware matcher
  // in src/middleware.ts excludes any path containing a dot (it's there to
  // skip static-asset requests), so URLs ending in `.md` bypass the locale
  // redirect and land at `/_not-found`. The route handler at
  // [...path]/page.tsx re-appends `.md` server-side. Closes #207.
  const stripped = relPath.replace(/\.md$/i, '');
  return '/admin/codex/note/' + stripped
    .split(/[\\/]/g)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

// Memoized so a parent re-render that doesn't change tree props
// (e.g. a sidebar dialog opens elsewhere in CodexBrowser) skips the
// tree re-render entirely. Caller must keep handlers + multiSelect
// referentially stable for this to actually help — see CodexBrowser's
// useCallback / useMemo discipline at the call site.
function CodexTreeInner({
  root,
  selectedPath,
  onRename,
  onDelete,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMove,
  multiSelect,
}: Props) {
  if (!root) return null;
  return (
    <ul className={styles.tree}>
      {root.children?.map((child) => (
        <TreeItem
          key={child.path}
          node={child}
          selectedPath={selectedPath}
          depth={0}
          onRename={onRename}
          onDelete={onDelete}
          onCreateFolder={onCreateFolder}
          onRenameFolder={onRenameFolder}
          onDeleteFolder={onDeleteFolder}
          onMove={onMove}
          multiSelect={multiSelect}
        />
      ))}
    </ul>
  );
}

const CodexTree = memo(CodexTreeInner);
export default CodexTree;

function TreeItem({
  node,
  selectedPath,
  depth,
  onRename,
  onDelete,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMove,
  multiSelect,
}: {
  node: CodexTreeNode;
  selectedPath?: string;
  depth: number;
  onRename?: (node: CodexTreeNode) => void;
  onDelete?: (node: CodexTreeNode) => void;
  onCreateFolder?: (parent: CodexTreeNode | null) => void;
  onRenameFolder?: (node: CodexTreeNode) => void;
  onDeleteFolder?: (node: CodexTreeNode) => void;
  onMove?: (source: CodexTreeNode, destFolderPath: string) => void;
  multiSelect?: Props['multiSelect'];
}) {
  // Folders auto-expand if they contain the selected note.
  const containsSelected = useMemo(() => {
    if (!selectedPath) return false;
    return selectedPath.startsWith(node.path + '/') || selectedPath.startsWith(node.path + '\\');
  }, [node.path, selectedPath]);

  // Default open at top level only.
  const [open, setOpen] = useState(depth < 1 || containsSelected);

  const toggle = useCallback(() => setOpen((v) => !v), []);

  if (node.kind === 'FOLDER') {
    return (
      <FolderTreeItem
        node={node}
        selectedPath={selectedPath}
        depth={depth}
        open={open}
        toggle={toggle}
        onRename={onRename}
        onDelete={onDelete}
        onCreateFolder={onCreateFolder}
        onRenameFolder={onRenameFolder}
        onDeleteFolder={onDeleteFolder}
        onMove={onMove}
        multiSelect={multiSelect}
      />
    );
  }

  return (
    <NoteTreeItem
      node={node}
      selectedPath={selectedPath}
      onRename={onRename}
      onDelete={onDelete}
      onMove={onMove}
      multiSelect={multiSelect}
    />
  );
}

function FolderTreeItem({
  node,
  selectedPath,
  depth,
  open,
  toggle,
  onRename,
  onDelete,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onMove,
  multiSelect,
}: {
  node: CodexTreeNode;
  selectedPath?: string;
  depth: number;
  open: boolean;
  toggle: () => void;
  onRename?: (node: CodexTreeNode) => void;
  onDelete?: (node: CodexTreeNode) => void;
  onCreateFolder?: (parent: CodexTreeNode | null) => void;
  onRenameFolder?: (node: CodexTreeNode) => void;
  onDeleteFolder?: (node: CodexTreeNode) => void;
  onMove?: (source: CodexTreeNode, destFolderPath: string) => void;
  multiSelect?: Props['multiSelect'];
}) {
  const [menuOpen, setMenuOpen] = useState<{ x: number; y: number } | null>(null);
  const [dropActive, setDropActive] = useState<boolean>(false);

  const isAutoManagedFolder =
    node.path.startsWith('70 - Journals') || node.path.startsWith('80 - Daily');

  const hasMenuActions = !!(onCreateFolder || onRenameFolder || onDeleteFolder);

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!hasMenuActions || isAutoManagedFolder) return;
      e.preventDefault();
      setMenuOpen({ x: e.clientX, y: e.clientY });
    },
    [hasMenuActions, isAutoManagedFolder],
  );
  const closeMenu = useCallback(() => setMenuOpen(null), []);

  // Drag-and-drop: any draggable tree row dropped on this folder row triggers
  // onMove. Auto-managed folders refuse drops.
  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!onMove || isAutoManagedFolder) return;
      const sourcePath = e.dataTransfer.types.includes('text/x-codex-path');
      if (!sourcePath) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      setDropActive(true);
    },
    [onMove, isAutoManagedFolder],
  );
  const onDragLeave = useCallback(() => setDropActive(false), []);
  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!onMove || isAutoManagedFolder) return;
      e.preventDefault();
      setDropActive(false);
      const payload = e.dataTransfer.getData('text/x-codex-path');
      if (!payload) return;
      try {
        const source = JSON.parse(payload) as CodexTreeNode;
        // Refuse drops onto self or into one's own descendants.
        if (source.path === node.path) return;
        if (node.path.startsWith(source.path + '/')) return;
        // Refuse drops into the same parent (no-op).
        const sourceParent = source.path.includes('/')
          ? source.path.slice(0, source.path.lastIndexOf('/'))
          : '';
        if (sourceParent === node.path) return;
        onMove(source, node.path);
      } catch {
        // Bad payload — ignore.
      }
    },
    [onMove, isAutoManagedFolder, node.path],
  );

  // Folder rows themselves are draggable so they can be moved between parents.
  const onDragStart = useCallback(
    (e: React.DragEvent) => {
      if (!onMove || isAutoManagedFolder) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData('text/x-codex-path', JSON.stringify(node));
      e.dataTransfer.effectAllowed = 'move';
    },
    [onMove, isAutoManagedFolder, node],
  );

  const menuItems: MenuItem[] = [];
  if (onCreateFolder) {
    menuItems.push({
      label: '+ New folder here',
      onClick: () => {
        closeMenu();
        onCreateFolder(node);
      },
    });
  }
  if (onRenameFolder) {
    menuItems.push({
      label: 'Rename folder…',
      onClick: () => {
        closeMenu();
        onRenameFolder(node);
      },
    });
  }
  if (onDeleteFolder) {
    menuItems.push({
      label: 'Delete folder…',
      onClick: () => {
        closeMenu();
        onDeleteFolder(node);
      },
      destructive: true,
    });
  }

  return (
    <li>
      <div
        role="button"
        tabIndex={0}
        className={`${styles.folderRow} ${dropActive ? styles.folderRowDropActive : ''}`}
        onClick={toggle}
        onContextMenu={onContextMenu}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
          }
        }}
        draggable={!!onMove && !isAutoManagedFolder}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <span className={styles.disclosure}>{open ? '▾' : '▸'}</span>
        <span>{node.name}</span>
      </div>
      {open && node.children && (
        <ul>
          {node.children.map((child) => (
            <TreeItem
              key={child.path}
              node={child}
              selectedPath={selectedPath}
              depth={depth + 1}
              onRename={onRename}
              onDelete={onDelete}
              onCreateFolder={onCreateFolder}
              onRenameFolder={onRenameFolder}
              onDeleteFolder={onDeleteFolder}
              onMove={onMove}
              multiSelect={multiSelect}
            />
          ))}
        </ul>
      )}
      {menuOpen && menuItems.length > 0 && (
        <ContextMenu
          x={menuOpen.x}
          y={menuOpen.y}
          onClose={closeMenu}
          items={menuItems}
        />
      )}
    </li>
  );
}

function NoteTreeItem({
  node,
  selectedPath,
  onRename,
  onDelete,
  onMove,
  multiSelect,
}: {
  node: CodexTreeNode;
  selectedPath?: string;
  onRename?: (node: CodexTreeNode) => void;
  onDelete?: (node: CodexTreeNode) => void;
  onMove?: (source: CodexTreeNode, destFolderPath: string) => void;
  multiSelect?: Props['multiSelect'];
}) {
  const { Link } = useCodexNavigation();
  const isSelected = selectedPath === node.path;
  const sClass = statusClass(node.status);
  const [menuOpen, setMenuOpen] = useState<{ x: number; y: number } | null>(null);
  const isMultiSelected = !!multiSelect?.selected.has(node.path);

  const hasMenuActions = !!(onRename || onDelete);

  // Right-click opens a small context menu. Auto-managed notes can't be
  // renamed or deleted (the nightly script regenerates their content), so
  // we suppress the menu in that case.
  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      if (!hasMenuActions || node.isAutoManaged) return;
      e.preventDefault();
      setMenuOpen({ x: e.clientX, y: e.clientY });
    },
    [hasMenuActions, node.isAutoManaged],
  );

  // Note rows are draggable so they can be moved into a different folder.
  const onDragStart = useCallback(
    (e: React.DragEvent) => {
      if (!onMove || node.isAutoManaged) {
        e.preventDefault();
        return;
      }
      e.dataTransfer.setData('text/x-codex-path', JSON.stringify(node));
      e.dataTransfer.effectAllowed = 'move';
    },
    [onMove, node],
  );

  // F2 keyboard shortcut: rename the focused note row. Delete shortcut is
  // intentionally NOT bound here — too easy to fire by accident; a deliberate
  // right-click → Delete is safer for a destructive op.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'F2' && onRename && !node.isAutoManaged) {
        e.preventDefault();
        e.stopPropagation();
        onRename(node);
      }
    },
    [onRename, node],
  );

  // Close the menu if the user clicks anywhere else.
  const closeMenu = useCallback(() => setMenuOpen(null), []);

  const menuItems: MenuItem[] = [];
  if (onRename) {
    menuItems.push({
      label: 'Rename… (F2)',
      onClick: () => {
        closeMenu();
        onRename(node);
      },
    });
  }
  if (onDelete) {
    menuItems.push({
      label: 'Delete…',
      onClick: () => {
        closeMenu();
        onDelete(node);
      },
      destructive: true,
    });
  }

  // Multi-select toggle: Cmd/Meta-click toggles, Shift-click range-selects.
  // Plain clicks fall through to <Link> so navigation is the default.
  const onClickMaybeMultiSelect = useCallback(
    (e: React.MouseEvent) => {
      if (!multiSelect) return;
      const meta = e.metaKey || e.ctrlKey;
      const shift = e.shiftKey;
      if (!meta && !shift) return;
      e.preventDefault();
      e.stopPropagation();
      multiSelect.onToggle(node.path, { meta, shift });
    },
    [multiSelect, node.path],
  );

  // Linkages page URL: same encoding scheme as noteHref (strip .md, segment-
  // encode) — required to dodge the next-intl middleware static-asset filter.
  const linkagesHref =
    '/admin/codex/graph/note/' +
    node.path
      .replace(/\.md$/i, '')
      .split(/[\\/]/g)
      .map((seg) => encodeURIComponent(seg))
      .join('/');

  return (
    <li className={styles.noteRowWrap}>
      <Link
        href={noteHref(node.path)}
        className={`${styles.noteRow} ${isSelected ? styles.noteRowActive : ''} ${isMultiSelected ? styles.noteRowMultiSelected : ''}`}
        onClick={onClickMaybeMultiSelect}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        draggable={!!onMove && !node.isAutoManaged}
        onDragStart={onDragStart}
      >
        <span className={styles.disclosure}>{isMultiSelected ? '✓' : '·'}</span>
        <span>{node.name}</span>
        {sClass && (
          <span className={`${styles.statusBadge} ${sClass}`}>{node.status}</span>
        )}
        {!sClass && node.isAutoManaged && (
          <span className={styles.autoBadge}>auto</span>
        )}
      </Link>
      <a
        href={linkagesHref}
        className={styles.noteRowLinkagesIcon}
        title="Show this document's link graph (across all folders)"
        aria-label="Show linkages"
        onClick={(e) => e.stopPropagation()}
      >
        🕸
      </a>
      {menuOpen && menuItems.length > 0 && (
        <ContextMenu
          x={menuOpen.x}
          y={menuOpen.y}
          onClose={closeMenu}
          items={menuItems}
        />
      )}
    </li>
  );
}

interface MenuItem {
  label: string;
  onClick: () => void;
  destructive?: boolean;
}

function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}) {
  return (
    <div
      className={styles.contextMenuBackdrop}
      onClick={onClose}
      onContextMenu={(e) => {
        e.preventDefault();
        onClose();
      }}
      role="presentation"
    >
      <ul
        className={styles.contextMenu}
        style={{ left: x, top: y }}
        role="menu"
        onClick={(e) => e.stopPropagation()}
      >
        {items.map((item) => (
          <li key={item.label} role="menuitem">
            <button
              type="button"
              className={`${styles.contextMenuItem} ${item.destructive ? styles.contextMenuItemDestructive : ''}`}
              onClick={item.onClick}
            >
              {item.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Re-export pure helper so the page can build the same href without depending
// on tree internals.
export { noteHref };
