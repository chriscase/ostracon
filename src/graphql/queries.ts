// AbydosCodex GraphQL queries — turnkey resolvers hosts can compose into
// their own Query type. Every resolver goes through the AuthAdapter
// (`requireCodexPermission`) so hosts plug their own auth without touching
// codex code.

import {
  GraphQLString,
  GraphQLInt,
  GraphQLBoolean,
  GraphQLNonNull,
  GraphQLList,
  type GraphQLFieldConfig,
} from 'graphql';
import type { CodexGraphQLContext } from './context';
import {
  requireCodexPermission,
  vaultExists,
  readVaultFile,
  parseNote,
  extractWikilinks,
  resolveWikilink,
  getIndex,
  getTree,
  getNoteMeta,
  contentSha,
  type NoteMeta,
  getGraph,
  getNoteNeighborhood,
  searchVault,
  noteHistory,
  computeVaultTags,
  previewVaultReplacement,
  getCodexUserPrefs,
} from '../server';
import {
  CodexTreeNodeType,
  CodexNoteType,
  CodexNoteSummaryType,
  CodexGraphType,
  CodexSearchHitType,
  CodexSearchModeEnum,
  CodexHistoryEntryType,
  CodexPreviewResultType,
  CodexTagSummaryType,
  CodexUserPrefsType,
} from './types';

function summarize(meta: NoteMeta) {
  return {
    path: meta.path,
    title: meta.title,
    folder: meta.folder,
    status: meta.status ?? null,
    tags: meta.tags,
    mtime: meta.mtime,
    size: meta.size,
    isAutoManaged: meta.isAutoManaged,
  };
}

export const codexQueryFields: Record<
  string,
  GraphQLFieldConfig<unknown, CodexGraphQLContext>
> = {
  vaultTree: {
    type: new GraphQLNonNull(CodexTreeNodeType),
    description: 'Full folder/note tree of the AbydosCodex vault.',
    resolve: async (_parent, _args, context) => {
      await requireCodexPermission(context, 'codex.read');
      if (!(await vaultExists())) {
        throw new Error('Vault not found on this server. Set ABYDOS_VAULT_PATH and clone the repo.');
      }
      return getTree();
    },
  },

  vaultNote: {
    type: CodexNoteType,
    description: 'Full content + metadata for a single note, by relative vault path.',
    args: {
      path: { type: new GraphQLNonNull(GraphQLString) },
    },
    resolve: async (_parent, args, context) => {
      await requireCodexPermission(context, 'codex.read');
      const meta = await getNoteMeta(args.path as string);
      if (!meta) return null;

      const idx = await getIndex();
      const content = await readVaultFile(args.path as string);

      const outboundLinks = extractWikilinks(content).map((link) => ({
        target: link.target,
        anchor: link.anchor ?? null,
        alias: link.alias ?? null,
        isEmbed: link.isEmbed,
        resolvedPath: resolveWikilink(link.target, idx.titles),
      }));

      const inboundPaths = new Set<string>();
      for (const edge of idx.edges) {
        if (edge.to === args.path) inboundPaths.add(edge.from);
      }
      const inboundLinks = [...inboundPaths]
        .map((p) => idx.files.get(p))
        .filter((m): m is NoteMeta => Boolean(m))
        .map(summarize)
        .sort((a, b) => a.path.localeCompare(b.path));

      return {
        ...summarize(meta),
        content,
        sha: contentSha(content),
        outboundLinks,
        inboundLinks,
      };
    },
  },

  vaultNoteSummary: {
    type: CodexNoteSummaryType,
    description: 'Summary metadata for a note (no content). Cheap; useful for tree/list views.',
    args: {
      path: { type: new GraphQLNonNull(GraphQLString) },
    },
    resolve: async (_parent, args, context) => {
      await requireCodexPermission(context, 'codex.read');
      const parsed = await getNoteMeta(args.path as string);
      void parseNote;
      return parsed ? summarize(parsed) : null;
    },
  },

  vaultGraph: {
    type: new GraphQLNonNull(CodexGraphType),
    description:
      'Vault link graph. scope=null returns one supernode per top-level folder; scope="20 - Products" returns the per-folder note graph laid out by PageRank.',
    args: {
      scope: { type: GraphQLString },
    },
    resolve: async (_parent, args, context) => {
      await requireCodexPermission(context, 'codex.read');
      if (!(await vaultExists())) {
        throw new Error('Vault not found on this server.');
      }
      return getGraph((args.scope as string | null | undefined) ?? null);
    },
  },

  vaultNoteNeighborhood: {
    type: new GraphQLNonNull(CodexGraphType),
    description:
      'Note-centric subgraph: BFS in the full vault edge graph (no folder boundary), depth N hops.',
    args: {
      notePath: { type: new GraphQLNonNull(GraphQLString) },
      depth: { type: GraphQLInt },
    },
    resolve: async (_parent, args, context) => {
      await requireCodexPermission(context, 'codex.read');
      if (!(await vaultExists())) {
        throw new Error('Vault not found on this server.');
      }
      return getNoteNeighborhood(args.notePath as string, (args.depth as number | undefined) ?? 2);
    },
  },

  vaultSearch: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(CodexSearchHitType))),
    description:
      'Search the vault. When the host has registered a SearchAdapter on context.codexSearch (e.g. a Postgres tsvector or pgvector backend), the resolver delegates to it; otherwise falls through to the in-memory default (substring + tag match).',
    args: {
      query: { type: new GraphQLNonNull(GraphQLString) },
      limit: { type: GraphQLInt },
      /** Restrict to notes whose path starts with this prefix. Host
       *  adapters honor this; the in-memory default ignores it. */
      folder: { type: GraphQLString },
      /** Restrict to notes carrying any of these tags. Host adapters
       *  honor this; the in-memory default ignores it. */
      tags: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
      /** Restrict to notes with this status frontmatter value. */
      status: { type: GraphQLString },
      /** Search mode: substring / fulltext / semantic / hybrid. The
       *  in-memory default treats anything but 'substring' as substring.
       *  Hosts pick the best fit per mode. */
      mode: { type: CodexSearchModeEnum },
    },
    resolve: async (_parent, args, context) => {
      await requireCodexPermission(context, 'codex.read');
      const query = args.query as string;
      const limit = (args.limit as number | undefined) ?? 20;
      const folder = args.folder as string | undefined;
      const tags = args.tags as string[] | undefined;
      const status = args.status as string | undefined;
      const mode = args.mode as
        | 'substring'
        | 'fulltext'
        | 'semantic'
        | 'hybrid'
        | undefined;

      // When the host has registered a SearchAdapter, delegate. The
      // adapter handles ranking, mode selection, and filter semantics.
      if (context.codexSearch) {
        const hits = await context.codexSearch.search({
          q: query,
          limit,
          folder,
          tags,
          status,
          mode,
        });
        return hits.map((h) => ({
          note: summarize(h.meta),
          score: h.score,
          matchedOn: h.matchedOn,
          excerpt: h.excerpt,
        }));
      }

      // No adapter — fall back to the in-memory default. It only
      // implements substring + tag match; folder/tags/status/mode args
      // are silently ignored.
      const hits = await searchVault(query, limit);
      return hits.map((h) => ({
        note: summarize(h.meta),
        score: h.score,
        matchedOn: h.matchedOn,
        excerpt: h.excerpt,
      }));
    },
  },

  vaultNoteHistory: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(CodexHistoryEntryType))),
    description:
      'Per-commit history for a vault note (uses git log --follow so renames flow). Each entry includes a path-scoped unified diff. Limit defaults to 50.',
    args: {
      path: { type: new GraphQLNonNull(GraphQLString) },
      limit: { type: GraphQLInt },
    },
    resolve: async (_parent, args, context) => {
      await requireCodexPermission(context, 'codex.read');
      if (!(await vaultExists())) {
        throw new Error('Vault not found on this server.');
      }
      return noteHistory(args.path as string, (args.limit as number | undefined) ?? 50);
    },
  },

  vaultPreviewReplacement: {
    type: new GraphQLNonNull(CodexPreviewResultType),
    description:
      'Non-mutating preview of a vault-wide find-and-replace. Pass `regex: true` for regex mode, `wikilinkAware: true` to interpret query/replacement as old/new vault paths.',
    args: {
      query: { type: new GraphQLNonNull(GraphQLString) },
      replacement: { type: new GraphQLNonNull(GraphQLString) },
      caseSensitive: { type: GraphQLBoolean },
      regex: { type: GraphQLBoolean },
      wholeWord: { type: GraphQLBoolean },
      wikilinkAware: { type: GraphQLBoolean },
      pathScope: { type: new GraphQLList(new GraphQLNonNull(GraphQLString)) },
    },
    resolve: async (_parent, args, context) => {
      await requireCodexPermission(context, 'codex.read');
      if (!(await vaultExists())) {
        throw new Error('Vault not found on this server.');
      }
      return previewVaultReplacement({
        query: args.query as string,
        replacement: args.replacement as string,
        caseSensitive: (args.caseSensitive as boolean | undefined) ?? false,
        regex: (args.regex as boolean | undefined) ?? false,
        wholeWord: (args.wholeWord as boolean | undefined) ?? false,
        wikilinkAware: (args.wikilinkAware as boolean | undefined) ?? false,
        pathScope: (args.pathScope as string[] | undefined) ?? undefined,
      });
    },
  },

  vaultTags: {
    type: new GraphQLNonNull(new GraphQLList(new GraphQLNonNull(CodexTagSummaryType))),
    description: 'All tags across the vault, ranked by usage.',
    resolve: async (_parent, _args, context) => {
      await requireCodexPermission(context, 'codex.read');
      if (!(await vaultExists())) {
        throw new Error('Vault not found on this server.');
      }
      return computeVaultTags();
    },
  },

  myCodexPrefs: {
    type: new GraphQLNonNull(CodexUserPrefsType),
    description:
      'Per-user codex prefs (recent + pinned vault paths). Empty defaults for users who have never touched the codex browser.',
    resolve: async (_parent, _args, context) => {
      const user = await requireCodexPermission(context, 'codex.read');
      const prefs = await getCodexUserPrefs(context.prisma, user.id);
      return {
        recentPaths: prefs.recentPaths,
        pinnedPaths: prefs.pinnedPaths,
        updatedAt: prefs.updatedAt.toISOString(),
      };
    },
  },
};

export const {
  vaultTree,
  vaultNote,
  vaultNoteSummary,
  vaultGraph,
  vaultNoteNeighborhood,
  vaultSearch,
  vaultNoteHistory,
  vaultPreviewReplacement,
  vaultTags,
  myCodexPrefs,
} = codexQueryFields;
