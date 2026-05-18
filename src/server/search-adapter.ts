// SearchAdapter contract — let hosts plug their own search backend
// (Postgres tsvector, MeiliSearch, Algolia, semantic via embeddings, …).
//
// The default in-memory implementation lives in `search.ts` and handles
// substring + tag matching. Hosts register a SearchAdapter on the GraphQL
// context (`context.codexSearch`); when present, the search resolver
// delegates to it instead of the in-memory default.
//
// The adapter contract intentionally mirrors the existing in-memory return
// shape so swapping backends is a no-op for consumers.

import type { NoteMeta } from './vault-index';
import type { VaultEvent } from './event-adapter';

export type SearchMode = 'substring' | 'fulltext' | 'semantic' | 'hybrid';

// Note: in-memory `SearchHit` from `search.ts` is the established public
// type for the default adapter's return shape. Adapter authors can return
// values of that exact shape or use the wider AdapterSearchHit (which adds
// 'alias' + 'semantic' match kinds — the in-memory impl doesn't produce
// them today but external adapters might). The interface declares the
// wider type so future-built-in adapters don't have to widen later.

export interface AdapterSearchQuery {
  q: string;
  limit?: number;
  /** Restrict to notes whose path starts with this prefix. */
  folder?: string;
  /** Restrict to notes carrying any of these tags. */
  tags?: string[];
  /** Restrict to notes with this status. */
  status?: string;
  /** Ranking strategy. Adapters may not support every mode; fall back
   *  silently to their best effort and never throw. */
  mode?: SearchMode;
}

export interface AdapterSearchHit {
  meta: NoteMeta;
  /** Where the match was found. 'semantic' for embedding-similarity hits;
   *  'alias' when the match came from a frontmatter `aliases` entry. */
  matchedOn: 'title' | 'body' | 'tag' | 'alias' | 'path' | 'semantic';
  /** Body excerpt around the match, with the matched span highlighted
   *  (e.g. <mark>...</mark>). Optional — adapters may omit. */
  excerpt?: string;
  /** Backend-dependent score, higher = more relevant. Treat as
   *  opaque-but-orderable. */
  score: number;
}

export interface SearchAdapter {
  search(query: AdapterSearchQuery): Promise<AdapterSearchHit[]>;
  /** Notify the adapter that the vault changed so it can refresh its
   *  external index. Optional — only used by adapters that maintain
   *  out-of-process state (Postgres rows, MeiliSearch docs, ...).
   *  Wire this to the EventAdapter on the host side. */
  notifyChange?(event: VaultEvent): Promise<void> | void;
}
