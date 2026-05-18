// AbydosCodex GraphQL mutations — turnkey resolvers hosts can compose into
// their own Mutation type. Every vault-touching path goes through the
// sync coordinator (which handles the mutex + secret scan + auto-managed
// guard + commit + debounced push). Author identity flows from the
// AuthAdapter; commit-message phrasing pulls the host's `editedVia` tag
// from context so "via HallOfRecords v1" / "via Abydonian admin" / etc.
// renders correctly without host-specific code in here.

import {
  GraphQLString,
  GraphQLNonNull,
  GraphQLBoolean,
  GraphQLList,
  type GraphQLFieldConfig,
} from 'graphql';
import type { CodexGraphQLContext } from './context';
import {
  requireCodexPermission,
  type CodexUser,
  saveNote,
  renameNote,
  deleteNote,
  createFolder,
  renameFolder,
  deleteFolder,
  moveNote,
  moveFolder,
  revertNote,
  applyVaultReplacement,
  renameTag,
  deleteTag,
  type SaveOutcome,
  type RenameOutcome,
  type DeleteOutcome,
  type CreateFolderOutcome,
  type RenameFolderOutcome,
  type DeleteFolderOutcome,
  type RevertOutcome,
  type TagMutationOutcome,
  type ApplyOutcome,
  bumpCodexRecent,
  pinCodexNote,
  unpinCodexNote,
  vaultExists,
} from '../server';
import {
  CodexSaveResultType,
  CodexRenameResultType,
  CodexDeleteResultType,
  CodexCreateFolderResultType,
  CodexRenameFolderResultType,
  CodexRevertResultType,
  CodexDeleteFolderResultType,
  CodexApplyResultType,
  CodexTagMutationResultType,
  CodexUserPrefsType,
} from './types';

function authorFromUser(user: CodexUser) {
  return {
    name: user.name ?? user.email.split('@')[0],
    email: user.email,
  };
}

function defaultMessage(verb: string, path: string, context: CodexGraphQLContext) {
  const via = context.editedVia ?? 'Ostracon';
  return `${verb} ${path} via ${via}`;
}

function outcomeToPayload(outcome: SaveOutcome) {
  switch (outcome.kind) {
    case 'OK':
      return { kind: 'OK', newSha: outcome.newSha, commitSha: outcome.commitSha };
    case 'NOOP':
      return { kind: 'NOOP', newSha: outcome.sha };
    case 'CONFLICT':
      return {
        kind: 'CONFLICT',
        currentContent: outcome.currentContent,
        currentSha: outcome.currentSha,
      };
    case 'SECRETS':
      return { kind: 'SECRETS', secrets: outcome.hits };
    case 'AUTO_MANAGED':
      return { kind: 'AUTO_MANAGED', reason: outcome.reason };
  }
}

export const codexMutationFields: Record<
  string,
  GraphQLFieldConfig<unknown, CodexGraphQLContext>
> = {
  saveNote: {
    type: new GraphQLNonNull(CodexSaveResultType),
    description:
      'Update an existing vault note. baseSha must match the SHA the caller observed; otherwise CONFLICT is returned with the current content.',
    args: {
      path: { type: new GraphQLNonNull(GraphQLString) },
      content: { type: new GraphQLNonNull(GraphQLString) },
      baseSha: { type: new GraphQLNonNull(GraphQLString) },
      commitMessage: { type: GraphQLString },
    },
    resolve: async (_parent, args, context) => {
      const user = await requireCodexPermission(context, 'codex.write');
      if (!(await vaultExists())) throw new Error('Vault not found on this server.');

      const message =
        (args.commitMessage as string | undefined)?.trim() ||
        defaultMessage('Edit', args.path as string, context);

      const outcome = await saveNote({
        path: args.path as string,
        content: args.content as string,
        baseSha: args.baseSha as string,
        author: authorFromUser(user),
        commitMessage: message,
      });
      return outcomeToPayload(outcome);
    },
  },

  createNote: {
    type: new GraphQLNonNull(CodexSaveResultType),
    description: 'Create a new vault note at the given relative path.',
    args: {
      path: { type: new GraphQLNonNull(GraphQLString) },
      content: { type: new GraphQLNonNull(GraphQLString) },
      commitMessage: { type: GraphQLString },
    },
    resolve: async (_parent, args, context) => {
      const user = await requireCodexPermission(context, 'codex.write');
      if (!(await vaultExists())) throw new Error('Vault not found on this server.');

      const message =
        (args.commitMessage as string | undefined)?.trim() ||
        defaultMessage('Create', args.path as string, context);

      const outcome = await saveNote({
        path: args.path as string,
        content: args.content as string,
        baseSha: null,
        author: authorFromUser(user),
        commitMessage: message,
      });
      return outcomeToPayload(outcome);
    },
  },

  renameNote: {
    type: new GraphQLNonNull(CodexRenameResultType),
    description:
      'Rename or move a vault note. Atomically rewrites every inbound wikilink and commits the rename + rewrites in one git commit.',
    args: {
      oldPath: { type: new GraphQLNonNull(GraphQLString) },
      newPath: { type: new GraphQLNonNull(GraphQLString) },
      commitMessage: { type: GraphQLString },
    },
    resolve: async (_parent, args, context) => {
      const user = await requireCodexPermission(context, 'codex.write');
      if (!(await vaultExists())) throw new Error('Vault not found on this server.');

      const message =
        (args.commitMessage as string | undefined)?.trim() ||
        `Rename ${args.oldPath as string} → ${args.newPath as string} via ${context.editedVia ?? 'Ostracon'}`;

      const outcome = await renameNote({
        oldPath: args.oldPath as string,
        newPath: args.newPath as string,
        author: authorFromUser(user),
        commitMessage: message,
      });
      return renameOutcomeToPayload(outcome);
    },
  },

  deleteNote: {
    type: new GraphQLNonNull(CodexDeleteResultType),
    description:
      'Delete a vault note. Returns the list of paths that linked to the deleted note (now orphan links) so the UI can warn the user.',
    args: {
      path: { type: new GraphQLNonNull(GraphQLString) },
      commitMessage: { type: GraphQLString },
    },
    resolve: async (_parent, args, context) => {
      const user = await requireCodexPermission(context, 'codex.delete');
      if (!(await vaultExists())) throw new Error('Vault not found on this server.');

      const message =
        (args.commitMessage as string | undefined)?.trim() ||
        defaultMessage('Delete', args.path as string, context);

      const outcome = await deleteNote({
        path: args.path as string,
        author: authorFromUser(user),
        commitMessage: message,
      });
      return deleteOutcomeToPayload(outcome);
    },
  },

  createFolder: {
    type: new GraphQLNonNull(CodexCreateFolderResultType),
    description: 'Create a new vault folder. mkdir + drop a .gitkeep so git tracks the otherwise-empty directory.',
    args: {
      path: { type: new GraphQLNonNull(GraphQLString) },
      commitMessage: { type: GraphQLString },
    },
    resolve: async (_parent, args, context) => {
      const user = await requireCodexPermission(context, 'codex.write');
      if (!(await vaultExists())) throw new Error('Vault not found on this server.');

      const message =
        (args.commitMessage as string | undefined)?.trim() ||
        defaultMessage('Create folder', args.path as string, context);

      const outcome = await createFolder({
        path: args.path as string,
        author: authorFromUser(user),
        commitMessage: message,
      });
      return createFolderOutcomeToPayload(outcome);
    },
  },

  renameFolder: {
    type: new GraphQLNonNull(CodexRenameFolderResultType),
    description:
      'Rename or move a vault folder. Recursively renames every note inside, rewrites every inbound wikilink, and commits the whole thing atomically.',
    args: {
      oldPath: { type: new GraphQLNonNull(GraphQLString) },
      newPath: { type: new GraphQLNonNull(GraphQLString) },
      commitMessage: { type: GraphQLString },
    },
    resolve: async (_parent, args, context) => {
      const user = await requireCodexPermission(context, 'codex.write');
      if (!(await vaultExists())) throw new Error('Vault not found on this server.');

      const message =
        (args.commitMessage as string | undefined)?.trim() ||
        `Rename folder ${args.oldPath as string} → ${args.newPath as string} via ${context.editedVia ?? 'Ostracon'}`;

      const outcome = await renameFolder({
        oldPath: args.oldPath as string,
        newPath: args.newPath as string,
        author: authorFromUser(user),
        commitMessage: message,
      });
      return renameFolderOutcomeToPayload(outcome);
    },
  },

  deleteFolder: {
    type: new GraphQLNonNull(CodexDeleteFolderResultType),
    description:
      'Delete a vault folder. Refuses non-empty folders unless force=true.',
    args: {
      path: { type: new GraphQLNonNull(GraphQLString) },
      force: { type: GraphQLBoolean },
      commitMessage: { type: GraphQLString },
    },
    resolve: async (_parent, args, context) => {
      const user = await requireCodexPermission(context, 'codex.delete');
      if (!(await vaultExists())) throw new Error('Vault not found on this server.');

      const message =
        (args.commitMessage as string | undefined)?.trim() ||
        defaultMessage('Delete folder', args.path as string, context);

      const outcome = await deleteFolder({
        path: args.path as string,
        force: (args.force as boolean | undefined) ?? false,
        author: authorFromUser(user),
        commitMessage: message,
      });
      return deleteFolderOutcomeToPayload(outcome);
    },
  },

  moveNote: {
    type: new GraphQLNonNull(CodexRenameResultType),
    description:
      'Move a note into a different folder. Thin wrapper around renameNote that computes the destination from newParentPath + the source basename.',
    args: {
      oldPath: { type: new GraphQLNonNull(GraphQLString) },
      newParentPath: { type: new GraphQLNonNull(GraphQLString) },
      commitMessage: { type: GraphQLString },
    },
    resolve: async (_parent, args, context) => {
      const user = await requireCodexPermission(context, 'codex.write');
      if (!(await vaultExists())) throw new Error('Vault not found on this server.');

      const message =
        (args.commitMessage as string | undefined)?.trim() ||
        `Move ${args.oldPath as string} → ${args.newParentPath as string} via ${context.editedVia ?? 'Ostracon'}`;

      const outcome = await moveNote({
        oldPath: args.oldPath as string,
        newParentPath: args.newParentPath as string,
        author: authorFromUser(user),
        commitMessage: message,
      });
      return renameOutcomeToPayload(outcome);
    },
  },

  moveFolder: {
    type: new GraphQLNonNull(CodexRenameFolderResultType),
    description:
      'Move a folder into a different parent folder. Thin wrapper around renameFolder.',
    args: {
      oldPath: { type: new GraphQLNonNull(GraphQLString) },
      newParentPath: { type: new GraphQLNonNull(GraphQLString) },
      commitMessage: { type: GraphQLString },
    },
    resolve: async (_parent, args, context) => {
      const user = await requireCodexPermission(context, 'codex.write');
      if (!(await vaultExists())) throw new Error('Vault not found on this server.');

      const message =
        (args.commitMessage as string | undefined)?.trim() ||
        `Move folder ${args.oldPath as string} → ${args.newParentPath as string} via ${context.editedVia ?? 'Ostracon'}`;

      const outcome = await moveFolder({
        oldPath: args.oldPath as string,
        newParentPath: args.newParentPath as string,
        author: authorFromUser(user),
        commitMessage: message,
      });
      return renameFolderOutcomeToPayload(outcome);
    },
  },

  revertNote: {
    type: new GraphQLNonNull(CodexRevertResultType),
    description:
      'Restore a note to the version recorded at a specific past commit. Reads the historical content + writes it back as a new commit (NOT a `git revert`).',
    args: {
      path: { type: new GraphQLNonNull(GraphQLString) },
      sha: { type: new GraphQLNonNull(GraphQLString) },
      commitMessage: { type: GraphQLString },
    },
    resolve: async (_parent, args, context) => {
      const user = await requireCodexPermission(context, 'codex.write');
      if (!(await vaultExists())) throw new Error('Vault not found on this server.');

      const sha = args.sha as string;
      const message =
        (args.commitMessage as string | undefined)?.trim() ||
        `Revert ${args.path as string} to ${sha.slice(0, 7)} via ${context.editedVia ?? 'Ostracon'}`;

      const outcome = await revertNote({
        path: args.path as string,
        sha,
        author: authorFromUser(user),
        commitMessage: message,
      });
      return revertOutcomeToPayload(outcome);
    },
  },

  vaultApplyReplacement: {
    type: new GraphQLNonNull(CodexApplyResultType),
    description:
      'Apply a previously-previewed find-and-replace across the vault. Single atomic commit. Auto-managed paths skipped.',
    args: {
      query: { type: new GraphQLNonNull(GraphQLString) },
      replacement: { type: new GraphQLNonNull(GraphQLString) },
      caseSensitive: { type: GraphQLBoolean },
      regex: { type: GraphQLBoolean },
      wholeWord: { type: GraphQLBoolean },
      wikilinkAware: { type: GraphQLBoolean },
      pathScope: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
      commitMessage: { type: GraphQLString },
    },
    resolve: async (_parent, args, context) => {
      const user = await requireCodexPermission(context, 'codex.write');
      if (!(await vaultExists())) throw new Error('Vault not found on this server.');

      const outcome = await applyVaultReplacement({
        query: args.query as string,
        replacement: args.replacement as string,
        caseSensitive: (args.caseSensitive as boolean | undefined) ?? false,
        regex: (args.regex as boolean | undefined) ?? false,
        wholeWord: (args.wholeWord as boolean | undefined) ?? false,
        wikilinkAware: (args.wikilinkAware as boolean | undefined) ?? false,
        pathScope: (args.pathScope as string[] | undefined) ?? undefined,
        author: authorFromUser(user),
        commitMessage: (args.commitMessage as string | undefined) ?? undefined,
      });
      return applyOutcomeToPayload(outcome);
    },
  },

  renameTag: {
    type: new GraphQLNonNull(CodexTagMutationResultType),
    description:
      'Rename a tag across every note frontmatter. Single atomic commit. Auto-managed notes skipped.',
    args: {
      oldTag: { type: new GraphQLNonNull(GraphQLString) },
      newTag: { type: new GraphQLNonNull(GraphQLString) },
      commitMessage: { type: GraphQLString },
    },
    resolve: async (_parent, args, context) => {
      const user = await requireCodexPermission(context, 'codex.write');
      if (!(await vaultExists())) throw new Error('Vault not found on this server.');
      const outcome = await renameTag({
        oldTag: args.oldTag as string,
        newTag: args.newTag as string,
        author: authorFromUser(user),
        commitMessage: (args.commitMessage as string | undefined) ?? undefined,
      });
      return tagMutationOutcomeToPayload(outcome);
    },
  },

  deleteTag: {
    type: new GraphQLNonNull(CodexTagMutationResultType),
    description:
      'Remove a tag from every note frontmatter. Single atomic commit. Auto-managed notes skipped.',
    args: {
      tag: { type: new GraphQLNonNull(GraphQLString) },
      commitMessage: { type: GraphQLString },
    },
    resolve: async (_parent, args, context) => {
      const user = await requireCodexPermission(context, 'codex.delete');
      if (!(await vaultExists())) throw new Error('Vault not found on this server.');
      const outcome = await deleteTag({
        tag: args.tag as string,
        author: authorFromUser(user),
        commitMessage: (args.commitMessage as string | undefined) ?? undefined,
      });
      return tagMutationOutcomeToPayload(outcome);
    },
  },

  pinCodexNote: {
    type: new GraphQLNonNull(CodexUserPrefsType),
    description: "Add a vault path to the current user's pinned set.",
    args: { path: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: async (_parent, args, context) => {
      const user = await requireCodexPermission(context, 'codex.read');
      const prefs = await pinCodexNote(context.prisma, user.id, args.path as string);
      return {
        recentPaths: prefs.recentPaths,
        pinnedPaths: prefs.pinnedPaths,
        updatedAt: prefs.updatedAt.toISOString(),
      };
    },
  },

  unpinCodexNote: {
    type: new GraphQLNonNull(CodexUserPrefsType),
    description: "Remove a vault path from the current user's pinned set.",
    args: { path: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: async (_parent, args, context) => {
      const user = await requireCodexPermission(context, 'codex.read');
      const prefs = await unpinCodexNote(context.prisma, user.id, args.path as string);
      return {
        recentPaths: prefs.recentPaths,
        pinnedPaths: prefs.pinnedPaths,
        updatedAt: prefs.updatedAt.toISOString(),
      };
    },
  },

  bumpCodexRecent: {
    type: new GraphQLNonNull(CodexUserPrefsType),
    description:
      "Move a vault path to the front of the user's recent list. Caps at 10 entries.",
    args: { path: { type: new GraphQLNonNull(GraphQLString) } },
    resolve: async (_parent, args, context) => {
      const user = await requireCodexPermission(context, 'codex.read');
      const prefs = await bumpCodexRecent(context.prisma, user.id, args.path as string);
      return {
        recentPaths: prefs.recentPaths,
        pinnedPaths: prefs.pinnedPaths,
        updatedAt: prefs.updatedAt.toISOString(),
      };
    },
  },
};

function applyOutcomeToPayload(outcome: ApplyOutcome) {
  switch (outcome.kind) {
    case 'OK':
      return {
        kind: 'OK',
        commitSha: outcome.commitSha,
        filesChanged: outcome.filesChanged,
        totalReplacements: outcome.totalReplacements,
      };
    case 'NOOP':
    case 'INVALID':
      return { kind: outcome.kind, reason: outcome.reason };
  }
}

function tagMutationOutcomeToPayload(outcome: TagMutationOutcome) {
  switch (outcome.kind) {
    case 'OK':
      return {
        kind: 'OK',
        commitSha: outcome.commitSha,
        filesChanged: outcome.filesChanged,
      };
    case 'NOOP':
    case 'INVALID':
      return { kind: outcome.kind, reason: outcome.reason };
  }
}

function renameOutcomeToPayload(outcome: RenameOutcome) {
  switch (outcome.kind) {
    case 'OK':
      return {
        kind: 'OK',
        newPath: outcome.newPath,
        commitSha: outcome.commitSha,
        rewrittenFiles: outcome.rewrittenFiles,
      };
    case 'NOT_FOUND':
    case 'CONFLICT':
    case 'AUTO_MANAGED':
    case 'INVALID':
      return { kind: outcome.kind, reason: outcome.reason };
  }
}

function deleteOutcomeToPayload(outcome: DeleteOutcome) {
  switch (outcome.kind) {
    case 'OK':
      return {
        kind: 'OK',
        commitSha: outcome.commitSha,
        orphanedFiles: outcome.orphanedFiles,
      };
    case 'NOT_FOUND':
    case 'AUTO_MANAGED':
    case 'INVALID':
      return { kind: outcome.kind, reason: outcome.reason };
  }
}

function createFolderOutcomeToPayload(outcome: CreateFolderOutcome) {
  switch (outcome.kind) {
    case 'OK':
      return { kind: 'OK', path: outcome.path, commitSha: outcome.commitSha };
    case 'CONFLICT':
    case 'AUTO_MANAGED':
    case 'INVALID':
      return { kind: outcome.kind, reason: outcome.reason };
  }
}

function renameFolderOutcomeToPayload(outcome: RenameFolderOutcome) {
  switch (outcome.kind) {
    case 'OK':
      return {
        kind: 'OK',
        newPath: outcome.newPath,
        commitSha: outcome.commitSha,
        renamedNotes: outcome.renamedNotes,
        rewrittenFiles: outcome.rewrittenFiles,
      };
    case 'NOT_FOUND':
    case 'CONFLICT':
    case 'AUTO_MANAGED':
    case 'INVALID':
      return { kind: outcome.kind, reason: outcome.reason };
  }
}

function deleteFolderOutcomeToPayload(outcome: DeleteFolderOutcome) {
  switch (outcome.kind) {
    case 'OK':
      return {
        kind: 'OK',
        commitSha: outcome.commitSha,
        deletedFiles: outcome.deletedFiles,
        orphanedFiles: outcome.orphanedFiles,
      };
    case 'NOT_EMPTY':
      return {
        kind: 'NOT_EMPTY',
        reason: outcome.reason,
        fileCount: outcome.fileCount,
      };
    case 'NOT_FOUND':
    case 'AUTO_MANAGED':
    case 'INVALID':
      return { kind: outcome.kind, reason: outcome.reason };
  }
}

function revertOutcomeToPayload(outcome: RevertOutcome) {
  switch (outcome.kind) {
    case 'OK':
      return { kind: 'OK', commitSha: outcome.commitSha, newSha: outcome.newSha };
    case 'NOT_FOUND':
    case 'AUTO_MANAGED':
    case 'NOOP':
    case 'INVALID':
      return { kind: outcome.kind, reason: outcome.reason };
  }
}

export const {
  saveNote: saveNoteMutation,
  createNote: createNoteMutation,
  renameNote: renameNoteMutation,
  deleteNote: deleteNoteMutation,
  createFolder: createFolderMutation,
  renameFolder: renameFolderMutation,
  deleteFolder: deleteFolderMutation,
  moveNote: moveNoteMutation,
  moveFolder: moveFolderMutation,
  revertNote: revertNoteMutation,
  vaultApplyReplacement: vaultApplyReplacementMutation,
  renameTag: renameTagMutation,
  deleteTag: deleteTagMutation,
  pinCodexNote: pinCodexNoteMutation,
  unpinCodexNote: unpinCodexNoteMutation,
  bumpCodexRecent: bumpCodexRecentMutation,
} = codexMutationFields;
