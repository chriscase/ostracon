// GraphQL context contract for Ostracon's turnkey schema.
//
// Hosts that consume `@chriscase/ostracon/graphql` build their Apollo /
// graphql-yoga / mercurius context so it satisfies (or extends) this shape.
// Codex resolvers read only these fields; host-specific fields (userId,
// session token, RBAC role) live on the host's own extended context type
// and are invisible to codex code.
//
// The required keys are:
//   • prisma — used by the user-prefs resolvers (pin / unpin / bumpRecent /
//     myCodexPrefs). Hosts that omit user-prefs entirely can compose only
//     the non-prefs query / mutation fields and pass any value (cast).
//
// The optional keys are:
//   • codexAuth — the AuthAdapter used by `requireCodexPermission`. Hosts
//     register their auth impl here; unwired hosts get a clear error.
//   • editedVia — short tag interpolated into default commit messages
//     ("Edit <path> via <editedVia>"). Defaults to "Ostracon" when absent.
//     Hosts customize this to "HallOfRecords v1" / "Abydonian admin" / etc.

import type { PrismaClient } from '@prisma/client';
import type { AuthAdapter } from '../server/auth-adapter';
import type { EventAdapter } from '../server/event-adapter';
import type { SearchAdapter } from '../server/search-adapter';
import type { EmbeddingsAdapter } from '../server/embeddings-adapter';
import type { AnnotationAdapter } from '../server/annotation-adapter';

export interface CodexGraphQLContext {
  prisma: PrismaClient;
  codexAuth?: AuthAdapter;
  /** Optional host adapter — receives every successful mutation event
   *  so the host can keep derived state (search index, audit log,
   *  embeddings) in sync. */
  codexEvents?: EventAdapter;
  /** Optional host adapter — when present, the search resolver delegates
   *  to it; when absent, the resolver falls back to Ostracon's in-memory
   *  substring + tag search. */
  codexSearch?: SearchAdapter;
  /** Optional host adapter — when present, semantic search modes light
   *  up and concept-clustering / similarity features become available. */
  codexEmbeddings?: EmbeddingsAdapter;
  /** Optional host adapter — when present, the annotation/comment
   *  GraphQL fields are populated. */
  codexAnnotations?: AnnotationAdapter;
  /** Short tag interpolated into default commit messages. Hosts override
   *  this to attribute commits to a specific frontend (e.g. "HallOfRecords
   *  v1"). When undefined, falls back to "Ostracon". */
  editedVia?: string;
}
