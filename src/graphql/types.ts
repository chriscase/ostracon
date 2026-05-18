// AbydosCodex GraphQL types — vault tree, notes, search results, mutation
// outcomes. These are host-agnostic — every Ostracon-backed host renders
// the same shapes.

import {
  GraphQLObjectType,
  GraphQLString,
  GraphQLBoolean,
  GraphQLNonNull,
  GraphQLList,
  GraphQLEnumType,
  GraphQLFloat,
  GraphQLInt,
} from 'graphql';

export const CodexNodeKindEnum = new GraphQLEnumType({
  name: 'CodexNodeKind',
  values: {
    FOLDER: { value: 'FOLDER' },
    NOTE: { value: 'NOTE' },
  },
});

export const CodexTreeNodeType: GraphQLObjectType = new GraphQLObjectType({
  name: 'CodexTreeNode',
  fields: () => ({
    name: { type: new GraphQLNonNull(GraphQLString) },
    path: { type: new GraphQLNonNull(GraphQLString) },
    kind: { type: new GraphQLNonNull(CodexNodeKindEnum) },
    status: { type: GraphQLString },
    isAutoManaged: { type: GraphQLBoolean },
    children: { type: new GraphQLList(new GraphQLNonNull(CodexTreeNodeType)) },
  }),
});

export const CodexWikilinkType: GraphQLObjectType = new GraphQLObjectType({
  name: 'CodexWikilink',
  fields: () => ({
    target: { type: new GraphQLNonNull(GraphQLString) },
    anchor: { type: GraphQLString },
    alias: { type: GraphQLString },
    isEmbed: { type: new GraphQLNonNull(GraphQLBoolean) },
    resolvedPath: { type: GraphQLString },
  }),
});

export const CodexNoteSummaryType: GraphQLObjectType = new GraphQLObjectType({
  name: 'CodexNoteSummary',
  fields: () => ({
    path: { type: new GraphQLNonNull(GraphQLString) },
    title: { type: new GraphQLNonNull(GraphQLString) },
    folder: { type: new GraphQLNonNull(GraphQLString) },
    status: { type: GraphQLString },
    tags: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    mtime: { type: new GraphQLNonNull(GraphQLFloat) },
    size: { type: new GraphQLNonNull(GraphQLInt) },
    isAutoManaged: { type: new GraphQLNonNull(GraphQLBoolean) },
  }),
});

export const CodexNoteType: GraphQLObjectType = new GraphQLObjectType({
  name: 'CodexNote',
  fields: () => ({
    path: { type: new GraphQLNonNull(GraphQLString) },
    title: { type: new GraphQLNonNull(GraphQLString) },
    folder: { type: new GraphQLNonNull(GraphQLString) },
    status: { type: GraphQLString },
    tags: { type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))) },
    mtime: { type: new GraphQLNonNull(GraphQLFloat) },
    size: { type: new GraphQLNonNull(GraphQLInt) },
    isAutoManaged: { type: new GraphQLNonNull(GraphQLBoolean) },
    sha: { type: new GraphQLNonNull(GraphQLString) },
    content: { type: new GraphQLNonNull(GraphQLString) },
    outboundLinks: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(CodexWikilinkType))),
    },
    inboundLinks: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(CodexNoteSummaryType))),
    },
  }),
});

// ─── Graph + Search ─────────────────────────────────────────────

export const CodexGraphNodeKindEnum = new GraphQLEnumType({
  name: 'CodexGraphNodeKind',
  values: {
    SUPERNODE: { value: 'SUPERNODE' },
    NOTE: { value: 'NOTE' },
  },
});

export const CodexGraphNodeType: GraphQLObjectType = new GraphQLObjectType({
  name: 'CodexGraphNode',
  fields: () => ({
    id: { type: new GraphQLNonNull(GraphQLString) },
    label: { type: new GraphQLNonNull(GraphQLString) },
    kind: { type: new GraphQLNonNull(CodexGraphNodeKindEnum) },
    folder: { type: new GraphQLNonNull(GraphQLString) },
    pageRank: { type: new GraphQLNonNull(GraphQLFloat) },
    degree: { type: new GraphQLNonNull(GraphQLInt) },
    noteCount: { type: GraphQLInt },
    distance: { type: GraphQLInt },
  }),
});

export const CodexGraphEdgeType: GraphQLObjectType = new GraphQLObjectType({
  name: 'CodexGraphEdge',
  fields: () => ({
    from: { type: new GraphQLNonNull(GraphQLString) },
    to: { type: new GraphQLNonNull(GraphQLString) },
    weight: { type: new GraphQLNonNull(GraphQLInt) },
  }),
});

export const CodexGraphType: GraphQLObjectType = new GraphQLObjectType({
  name: 'CodexGraph',
  fields: () => ({
    scope: { type: GraphQLString },
    nodes: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(CodexGraphNodeType))),
    },
    edges: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(CodexGraphEdgeType))),
    },
  }),
});

export const CodexSearchHitMatchEnum = new GraphQLEnumType({
  name: 'CodexSearchHitMatch',
  values: {
    title: { value: 'title' },
    tag: { value: 'tag' },
    path: { value: 'path' },
    body: { value: 'body' },
    /** Frontmatter alias matched (host adapters that index aliases). */
    alias: { value: 'alias' },
    /** Embedding-similarity hit (semantic search mode). */
    semantic: { value: 'semantic' },
  },
});

/** Search mode the resolver passes through to the host adapter. The
 *  in-memory default ignores anything other than 'substring' and treats
 *  unknown modes as substring. */
export const CodexSearchModeEnum = new GraphQLEnumType({
  name: 'CodexSearchMode',
  values: {
    substring: { value: 'substring' },
    fulltext: { value: 'fulltext' },
    semantic: { value: 'semantic' },
    hybrid: { value: 'hybrid' },
  },
});

export const CodexSearchHitType: GraphQLObjectType = new GraphQLObjectType({
  name: 'CodexSearchHit',
  fields: () => ({
    note: { type: new GraphQLNonNull(CodexNoteSummaryType) },
    score: { type: new GraphQLNonNull(GraphQLInt) },
    matchedOn: { type: new GraphQLNonNull(CodexSearchHitMatchEnum) },
    excerpt: { type: GraphQLString },
  }),
});

// ─── Save / mutation responses ──────────────────────────────────

export const CodexSaveKindEnum = new GraphQLEnumType({
  name: 'CodexSaveKind',
  values: {
    OK: { value: 'OK' },
    CONFLICT: { value: 'CONFLICT' },
    SECRETS: { value: 'SECRETS' },
    AUTO_MANAGED: { value: 'AUTO_MANAGED' },
    NOOP: { value: 'NOOP' },
  },
});

export const CodexSecretHitType: GraphQLObjectType = new GraphQLObjectType({
  name: 'CodexSecretHit',
  fields: () => ({
    pattern: { type: new GraphQLNonNull(GraphQLString) },
    line: { type: new GraphQLNonNull(GraphQLInt) },
    snippet: { type: new GraphQLNonNull(GraphQLString) },
  }),
});

export const CodexSaveResultType: GraphQLObjectType = new GraphQLObjectType({
  name: 'CodexSaveResult',
  fields: () => ({
    kind: { type: new GraphQLNonNull(CodexSaveKindEnum) },
    newSha: { type: GraphQLString },
    commitSha: { type: GraphQLString },
    currentContent: { type: GraphQLString },
    currentSha: { type: GraphQLString },
    secrets: { type: new GraphQLList(new GraphQLNonNull(CodexSecretHitType)) },
    reason: { type: GraphQLString },
  }),
});

// ─── Rename / move ──────────────────────────────────────────────

export const CodexRenameKindEnum = new GraphQLEnumType({
  name: 'CodexRenameKind',
  values: {
    OK: { value: 'OK' },
    NOT_FOUND: { value: 'NOT_FOUND' },
    CONFLICT: { value: 'CONFLICT' },
    AUTO_MANAGED: { value: 'AUTO_MANAGED' },
    INVALID: { value: 'INVALID' },
  },
});

export const CodexRenameResultType: GraphQLObjectType = new GraphQLObjectType({
  name: 'CodexRenameResult',
  fields: () => ({
    kind: { type: new GraphQLNonNull(CodexRenameKindEnum) },
    newPath: { type: GraphQLString },
    commitSha: { type: GraphQLString },
    rewrittenFiles: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    reason: { type: GraphQLString },
  }),
});

// ─── Delete ─────────────────────────────────────────────────────

export const CodexDeleteKindEnum = new GraphQLEnumType({
  name: 'CodexDeleteKind',
  values: {
    OK: { value: 'OK' },
    NOT_FOUND: { value: 'NOT_FOUND' },
    AUTO_MANAGED: { value: 'AUTO_MANAGED' },
    INVALID: { value: 'INVALID' },
  },
});

export const CodexDeleteResultType: GraphQLObjectType = new GraphQLObjectType({
  name: 'CodexDeleteResult',
  fields: () => ({
    kind: { type: new GraphQLNonNull(CodexDeleteKindEnum) },
    commitSha: { type: GraphQLString },
    orphanedFiles: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    reason: { type: GraphQLString },
  }),
});

// ─── Create folder ──────────────────────────────────────────────

export const CodexCreateFolderKindEnum = new GraphQLEnumType({
  name: 'CodexCreateFolderKind',
  values: {
    OK: { value: 'OK' },
    CONFLICT: { value: 'CONFLICT' },
    AUTO_MANAGED: { value: 'AUTO_MANAGED' },
    INVALID: { value: 'INVALID' },
  },
});

export const CodexCreateFolderResultType: GraphQLObjectType = new GraphQLObjectType({
  name: 'CodexCreateFolderResult',
  fields: () => ({
    kind: { type: new GraphQLNonNull(CodexCreateFolderKindEnum) },
    path: { type: GraphQLString },
    commitSha: { type: GraphQLString },
    reason: { type: GraphQLString },
  }),
});

// ─── Rename folder ──────────────────────────────────────────────

export const CodexRenameFolderKindEnum = new GraphQLEnumType({
  name: 'CodexRenameFolderKind',
  values: {
    OK: { value: 'OK' },
    NOT_FOUND: { value: 'NOT_FOUND' },
    CONFLICT: { value: 'CONFLICT' },
    AUTO_MANAGED: { value: 'AUTO_MANAGED' },
    INVALID: { value: 'INVALID' },
  },
});

export const CodexRenameFolderResultType: GraphQLObjectType = new GraphQLObjectType({
  name: 'CodexRenameFolderResult',
  fields: () => ({
    kind: { type: new GraphQLNonNull(CodexRenameFolderKindEnum) },
    newPath: { type: GraphQLString },
    commitSha: { type: GraphQLString },
    renamedNotes: { type: GraphQLInt },
    rewrittenFiles: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    reason: { type: GraphQLString },
  }),
});

// ─── Delete folder ──────────────────────────────────────────────

export const CodexDeleteFolderKindEnum = new GraphQLEnumType({
  name: 'CodexDeleteFolderKind',
  values: {
    OK: { value: 'OK' },
    NOT_FOUND: { value: 'NOT_FOUND' },
    NOT_EMPTY: { value: 'NOT_EMPTY' },
    AUTO_MANAGED: { value: 'AUTO_MANAGED' },
    INVALID: { value: 'INVALID' },
  },
});

export const CodexDeleteFolderResultType: GraphQLObjectType = new GraphQLObjectType({
  name: 'CodexDeleteFolderResult',
  fields: () => ({
    kind: { type: new GraphQLNonNull(CodexDeleteFolderKindEnum) },
    commitSha: { type: GraphQLString },
    deletedFiles: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    orphanedFiles: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    fileCount: { type: GraphQLInt },
    reason: { type: GraphQLString },
  }),
});

// ─── History + revert ───────────────────────────────────────────

export const CodexHistoryEntryType: GraphQLObjectType = new GraphQLObjectType({
  name: 'CodexHistoryEntry',
  fields: () => ({
    sha: { type: new GraphQLNonNull(GraphQLString) },
    shortSha: { type: new GraphQLNonNull(GraphQLString) },
    authorName: { type: new GraphQLNonNull(GraphQLString) },
    authorEmail: { type: new GraphQLNonNull(GraphQLString) },
    date: { type: new GraphQLNonNull(GraphQLString) },
    message: { type: new GraphQLNonNull(GraphQLString) },
    diff: { type: new GraphQLNonNull(GraphQLString) },
  }),
});

export const CodexRevertKindEnum = new GraphQLEnumType({
  name: 'CodexRevertKind',
  values: {
    OK: { value: 'OK' },
    NOT_FOUND: { value: 'NOT_FOUND' },
    AUTO_MANAGED: { value: 'AUTO_MANAGED' },
    NOOP: { value: 'NOOP' },
    INVALID: { value: 'INVALID' },
  },
});

export const CodexRevertResultType: GraphQLObjectType = new GraphQLObjectType({
  name: 'CodexRevertResult',
  fields: () => ({
    kind: { type: new GraphQLNonNull(CodexRevertKindEnum) },
    commitSha: { type: GraphQLString },
    newSha: { type: GraphQLString },
    reason: { type: GraphQLString },
  }),
});

// ─── Find-and-replace ───────────────────────────────────────────

export const CodexPreviewExcerptType: GraphQLObjectType = new GraphQLObjectType({
  name: 'CodexPreviewExcerpt',
  fields: () => ({
    line: { type: new GraphQLNonNull(GraphQLInt) },
    column: { type: new GraphQLNonNull(GraphQLInt) },
    snippet: { type: new GraphQLNonNull(GraphQLString) },
  }),
});

export const CodexPreviewMatchType: GraphQLObjectType = new GraphQLObjectType({
  name: 'CodexPreviewMatch',
  fields: () => ({
    path: { type: new GraphQLNonNull(GraphQLString) },
    count: { type: new GraphQLNonNull(GraphQLInt) },
    excerpts: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(CodexPreviewExcerptType))),
    },
  }),
});

export const CodexPreviewResultType: GraphQLObjectType = new GraphQLObjectType({
  name: 'CodexPreviewResult',
  fields: () => ({
    totalMatches: { type: new GraphQLNonNull(GraphQLInt) },
    fileCount: { type: new GraphQLNonNull(GraphQLInt) },
    matches: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(CodexPreviewMatchType))),
    },
    truncated: { type: new GraphQLNonNull(GraphQLBoolean) },
    error: { type: GraphQLString },
  }),
});

export const CodexApplyKindEnum = new GraphQLEnumType({
  name: 'CodexApplyKind',
  values: {
    OK: { value: 'OK' },
    NOOP: { value: 'NOOP' },
    INVALID: { value: 'INVALID' },
  },
});

export const CodexApplyResultType: GraphQLObjectType = new GraphQLObjectType({
  name: 'CodexApplyResult',
  fields: () => ({
    kind: { type: new GraphQLNonNull(CodexApplyKindEnum) },
    commitSha: { type: GraphQLString },
    filesChanged: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    totalReplacements: { type: GraphQLInt },
    reason: { type: GraphQLString },
  }),
});

// ─── Tag browser + tag rename/delete ────────────────────────────

export const CodexTagSummaryType: GraphQLObjectType = new GraphQLObjectType({
  name: 'CodexTagSummary',
  fields: () => ({
    tag: { type: new GraphQLNonNull(GraphQLString) },
    count: { type: new GraphQLNonNull(GraphQLInt) },
    notes: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))),
    },
  }),
});

export const CodexTagMutationKindEnum = new GraphQLEnumType({
  name: 'CodexTagMutationKind',
  values: {
    OK: { value: 'OK' },
    INVALID: { value: 'INVALID' },
    NOOP: { value: 'NOOP' },
  },
});

export const CodexTagMutationResultType: GraphQLObjectType = new GraphQLObjectType({
  name: 'CodexTagMutationResult',
  fields: () => ({
    kind: { type: new GraphQLNonNull(CodexTagMutationKindEnum) },
    commitSha: { type: GraphQLString },
    filesChanged: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    reason: { type: GraphQLString },
  }),
});

// ─── User prefs ─────────────────────────────────────────────────

export const CodexUserPrefsType: GraphQLObjectType = new GraphQLObjectType({
  name: 'CodexUserPrefs',
  fields: () => ({
    recentPaths: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))),
    },
    pinnedPaths: {
      type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(GraphQLString))),
    },
    updatedAt: { type: new GraphQLNonNull(GraphQLString) },
  }),
});
