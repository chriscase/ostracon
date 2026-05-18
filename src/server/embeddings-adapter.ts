// EmbeddingsAdapter contract — host-pluggable vector index for
// semantic search and concept clustering.
//
// Hosts wire their own embedding provider (Voyage AI, OpenAI, local,
// Cohere, ...) and storage backend (pgvector, Pinecone, FAISS, ...).
// Ostracon never makes outbound HTTP calls on its own; it just defines
// the seam.
//
// Default is no-op — when no adapter is registered, semantic search
// modes return an empty result set + the search UI hides the mode.

import type { VaultEvent } from './event-adapter';

export interface EmbeddingVector {
  noteUuid: string;
  /** Paragraph hash (sha256 of paragraph text, sliced to 12 chars).
   *  When null/undefined, the vector represents the whole note. */
  paragraphAnchor?: string | null;
  vector: number[];
}

export interface SimilarityHit {
  noteUuid: string;
  path: string;
  paragraphAnchor?: string | null;
  /** Backend-dependent (cosine, dot-product, ...). Higher = more
   *  similar by adapter convention. */
  score: number;
  /** Excerpt to render in the UI. Adapter that store per-paragraph
   *  vectors should return the paragraph text here. */
  excerpt?: string;
}

export interface EmbeddingsAdapter {
  /** Embed an arbitrary text — used at query time. */
  embed(text: string): Promise<number[]>;
  /** (Re)index a single note. Implementations chunk content and store
   *  one or more vectors. Called from the host's EventAdapter listener
   *  on note.saved / note.created. */
  indexNote(uuid: string, content: string): Promise<void>;
  /** Remove all vectors for a deleted/renamed note. (Renames index the
   *  new path then remove the old.) */
  removeNote(uuid: string): Promise<void>;
  /** Semantic similarity search. Returns top-N hits ranked by the
   *  adapter's scoring function. */
  similar(
    query: string,
    opts?: { limit?: number; minScore?: number },
  ): Promise<SimilarityHit[]>;
  /** Optional bulk-rebuild hook for vault.bulk-pull. Hosts that want
   *  delta-only updates can implement this; others can rebuild from
   *  scratch via their own CLI. */
  notifyChange?(event: VaultEvent): Promise<void> | void;
}
