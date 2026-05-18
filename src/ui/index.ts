// Ostracon — UI public surface.
//
// Re-exports every React component a host needs to mount the codex. The
// host is responsible for: (1) wrapping the tree in <CodexAdaptersProvider>
// (or its own version with the right adapter implementations); (2) routing
// — these components don't own any URL prefix.
//
// ─── Mountable surface ──────────────────────────────────────────────
//
// CodexBrowser handles the welcome / tree / graph / note views in one
// component (gated by the `view` prop). CodexTagBrowser is the dedicated
// `/admin/codex/tags`-style page. Each is a self-contained client component
// that the host plugs into its own routing.

// Adapter contract surface.
export {
  CodexAdaptersProvider,
  useCodexAdapters,
  useCodexNavigation,
  useCodexGraphqlRequest,
  useCodexTheme,
  codexGraphqlRequest,
  type CodexAdapters,
  type CodexIcons,
  type CodexRouter,
  type CodexTheme,
  type GraphQLRequestFn,
  type GraphQLResponse,
  type NavigationAdapter,
  type NavigationLinkProps,
} from './CodexAdapters';

// Top-level mountable views.
export { default as CodexBrowser, type CodexView } from './CodexBrowser';
export { default as CodexTagBrowser } from './CodexTagBrowser';
export { default as CodexRoute, type CodexRouteSpec } from './CodexRoutes';

// Lower-level building blocks for hosts that want to compose their own UI.
export { default as CodexTree, noteHref, type CodexTreeNode } from './CodexTree';
export { default as CodexPreview, type CodexNote, type CodexResolvedLink } from './CodexPreview';
export { default as CodexEditor } from './CodexEditor';
export { default as CodexGraph } from './CodexGraph';
export { default as CodexSearch, type CodexSearchHit } from './CodexSearch';
export {
  SearchPalette,
  SearchPaletteTrigger,
  openSearchPalette,
  type SearchPaletteProps,
} from './SearchPalette';
export {
  default as ConceptPopover,
  PreviewLink,
  type ConceptPopoverProps,
  type PreviewLinkProps,
} from './ConceptPopover';
export { default as CommandPalette, type PaletteAction } from './CommandPalette';
export { default as QuickOpen } from './QuickOpen';
export { default as KeyboardShortcutsHelp } from './KeyboardShortcutsHelp';
export { default as HistoryPanel } from './HistoryPanel';
export { default as FindReplaceDialog } from './FindReplaceDialog';
export { default as BulkActionBar } from './BulkActionBar';
export { default as FrontmatterForm } from './FrontmatterForm';
export {
  default as NewNoteDialog,
  defaultNewNoteContent,
} from './NewNoteDialog';
export { default as NewFolderDialog } from './NewFolderDialog';
export { default as RenameDialog } from './RenameDialog';
export { default as RenameFolderDialog } from './RenameFolderDialog';
export { default as DeleteConfirmDialog } from './DeleteConfirmDialog';
export { default as DeleteFolderConfirmDialog } from './DeleteFolderConfirmDialog';

export {
  useShortcuts,
  registerShortcutHelp,
  useShortcutHelp,
  formatCombo,
  normalizeCombo,
  isMac,
  type ShortcutBinding,
  type ShortcutHandler,
  type ShortcutHelpEntry,
  type ShortcutMap,
} from './useKeyboardShortcuts';

// CSS module — hosts that want to override these classes can re-export
// or augment via their own CSS-in-JS layer. Re-exported here so codex
// internals + the host can share the same module identity.
export { default as codexStyles } from './codex.module.css';
