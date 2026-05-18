// Contract tests for the turnkey GraphQL schema export. These tests
// don't execute resolvers (that requires a wired AuthAdapter + Prisma
// + a real vault on disk — covered by host-side integration tests).
// They DO verify the public surface a host depends on: field names,
// types, argument shapes, and the ability to build a GraphQLSchema
// from the exported field maps.

import { describe, it, expect } from 'vitest';
import {
  GraphQLObjectType,
  GraphQLSchema,
  GraphQLString,
  printSchema,
} from 'graphql';
import { codexQueryFields, codexMutationFields } from '../index';
import * as types from '../types';

describe('codexQueryFields — public read surface', () => {
  it('exposes every expected query field', () => {
    const expected = [
      'vaultTree',
      'vaultNote',
      'vaultNoteSummary',
      'vaultGraph',
      'vaultNoteNeighborhood',
      'vaultSearch',
      'vaultNoteHistory',
      'vaultPreviewReplacement',
      'vaultTags',
      'myCodexPrefs',
    ];
    expect(Object.keys(codexQueryFields).sort()).toEqual(expected.sort());
  });

  it('every query field has a resolve function', () => {
    for (const [name, field] of Object.entries(codexQueryFields)) {
      expect(typeof field.resolve, `${name}.resolve`).toBe('function');
    }
  });

  it('every query field has a type', () => {
    for (const [name, field] of Object.entries(codexQueryFields)) {
      expect(field.type, `${name}.type`).toBeDefined();
    }
  });
});

describe('codexMutationFields — public write surface', () => {
  it('exposes every expected mutation field', () => {
    const expected = [
      'saveNote',
      'createNote',
      'renameNote',
      'deleteNote',
      'createFolder',
      'renameFolder',
      'deleteFolder',
      'moveNote',
      'moveFolder',
      'revertNote',
      'vaultApplyReplacement',
      'renameTag',
      'deleteTag',
      'pinCodexNote',
      'unpinCodexNote',
      'bumpCodexRecent',
    ];
    expect(Object.keys(codexMutationFields).sort()).toEqual(expected.sort());
  });

  it('every mutation field has a resolve function', () => {
    for (const [name, field] of Object.entries(codexMutationFields)) {
      expect(typeof field.resolve, `${name}.resolve`).toBe('function');
    }
  });

  it('saveNote takes path, content, baseSha, commitMessage', () => {
    const args = codexMutationFields.saveNote.args ?? {};
    expect(Object.keys(args).sort()).toEqual(
      ['baseSha', 'commitMessage', 'content', 'path'].sort(),
    );
  });

  it('createNote takes path, content, commitMessage (no baseSha)', () => {
    const args = codexMutationFields.createNote.args ?? {};
    expect(Object.keys(args).sort()).toEqual(
      ['commitMessage', 'content', 'path'].sort(),
    );
  });

  it('deleteFolder accepts a force flag', () => {
    const args = codexMutationFields.deleteFolder.args ?? {};
    expect(Object.keys(args)).toContain('force');
  });
});

describe('codex types — re-exports are complete', () => {
  it('exports every documented GraphQL type', () => {
    const expected = [
      'CodexNodeKindEnum',
      'CodexTreeNodeType',
      'CodexWikilinkType',
      'CodexNoteSummaryType',
      'CodexNoteType',
      'CodexGraphNodeKindEnum',
      'CodexGraphNodeType',
      'CodexGraphEdgeType',
      'CodexGraphType',
      'CodexSearchHitMatchEnum',
      'CodexSearchHitType',
      'CodexSaveKindEnum',
      'CodexSecretHitType',
      'CodexSaveResultType',
      'CodexRenameKindEnum',
      'CodexRenameResultType',
      'CodexDeleteKindEnum',
      'CodexDeleteResultType',
      'CodexCreateFolderKindEnum',
      'CodexCreateFolderResultType',
      'CodexRenameFolderKindEnum',
      'CodexRenameFolderResultType',
      'CodexDeleteFolderKindEnum',
      'CodexDeleteFolderResultType',
      'CodexHistoryEntryType',
      'CodexRevertKindEnum',
      'CodexRevertResultType',
      'CodexPreviewExcerptType',
      'CodexPreviewMatchType',
      'CodexPreviewResultType',
      'CodexApplyKindEnum',
      'CodexApplyResultType',
      'CodexTagSummaryType',
      'CodexTagMutationKindEnum',
      'CodexTagMutationResultType',
      'CodexUserPrefsType',
    ];
    for (const name of expected) {
      expect((types as Record<string, unknown>)[name], `types.${name}`).toBeDefined();
    }
  });
});

describe('host integration — can build a real GraphQLSchema from the fields', () => {
  it('composes a working Query + Mutation schema', () => {
    const Query = new GraphQLObjectType({
      name: 'Query',
      fields: { ...codexQueryFields, _ping: { type: GraphQLString } },
    });
    const Mutation = new GraphQLObjectType({
      name: 'Mutation',
      fields: codexMutationFields,
    });
    const schema = new GraphQLSchema({ query: Query, mutation: Mutation });

    const printed = printSchema(schema);
    // Spot-check: a few well-known field signatures appear in the SDL.
    expect(printed).toContain('vaultNote(path: String!)');
    expect(printed).toContain('saveNote(');
    expect(printed).toContain('type CodexNote {');
    expect(printed).toContain('enum CodexSaveKind');
  });

  it('produces a host-extensible schema (host can add own fields without conflict)', () => {
    const Query = new GraphQLObjectType({
      name: 'Query',
      fields: {
        ...codexQueryFields,
        // Host's own field on the same Query type — common composition pattern.
        hostHealthCheck: { type: GraphQLString, resolve: () => 'ok' },
      },
    });
    const schema = new GraphQLSchema({ query: Query });
    const printed = printSchema(schema);
    expect(printed).toContain('hostHealthCheck: String');
    expect(printed).toContain('vaultTree: CodexTreeNode!');
  });
});
