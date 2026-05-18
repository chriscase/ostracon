// Ostracon — server-side public surface.
//
// Re-exports every name a host needs to integrate the codex into a Next.js
// (or other Node) application. Internal helpers (test fixtures, intra-
// package implementation details) are NOT re-exported and live inside the
// individual modules.
//
// Categories:
//   • Auth contract: AuthAdapter / CodexUser / CodexPermission / requireCodexPermission
//   • Sync coordinator: every vault-mutating function (saveNote, renameNote,
//     deleteNote, createFolder, renameFolder, deleteFolder, moveNote,
//     moveFolder, uploadAttachment, revertNote, applyVaultReplacement,
//     renameTag, deleteTag, …) plus their outcome types.
//   • Vault index: getIndex, getTree, getNoteMeta, contentSha, type NoteMeta
//   • Filesystem helpers: readVaultFile, writeVaultFile, vaultExists,
//     readVaultBinary, resolveVaultPath, type PathTraversalError
//   • Frontmatter: parseNote, serializeNote, DEFAULT_STATUS_OPTIONS, types
//   • Wikilinks: extract / resolve / annotate / rewrite + types
//   • Search: searchVault
//   • Graph: getGraph, invalidatePageRank
//   • Find-replace engine: previewVaultReplacement, buildReplacer, globMatch
//   • Auto-managed paths: isAutoManagedPath
//   • User prefs: getCodexUserPrefs, bumpCodexRecent, pinCodexNote,
//     unpinCodexNote, type CodexUserPrefs, RECENTS_CAP
//   • Config: getVaultRoot, getAttachmentsDir, getMaxUploadBytes,
//     getAllowedAttachmentExts
//   • Git helpers: getFileHistory, readFileAtSha, type CommitHistoryEntry
//     (the rest of git.ts is internal — only sync.ts uses it)

export * from './auth-adapter';
export * from './sync';
export * from './vault-index';
export * from './fs';
export * from './frontmatter';
export * from './wikilinks';
export * from './search';
export * from './graph';
export * from './find-replace';
export * from './auto-managed';
export * from './user-prefs';
export * from './config';
export * from './uuid';
export * from './commit-format';
export {
  getFileHistory,
  readFileAtSha,
  type CommitHistoryEntry,
  fileBlobSha,
  resetGit,
} from './git';
