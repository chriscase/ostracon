// AnnotationAdapter contract — host-pluggable comments / per-paragraph
// annotations layer.
//
// Vault markdown stays the source of truth. Annotations are downstream
// user-data that lives in the host's database, anchored by note UUID
// (so they survive renames) and an optional paragraph hash (so they
// can attach to specific lines).
//
// Default is no-op — when no adapter is registered, the annotation UI
// is hidden and no GraphQL fields surface.

import type { CodexUser } from './auth-adapter';

export interface AnnotationAnchor {
  noteUuid: string;
  /** sha256(paragraph_text).slice(0,12). When null, the annotation
   *  attaches to the whole note rather than a specific paragraph. */
  paragraphAnchor?: string | null;
}

export interface AnnotationReaction {
  emoji: string;
  users: string[];
}

export interface Annotation {
  id: string;
  anchor: AnnotationAnchor;
  author: CodexUser;
  bodyMarkdown: string;
  /** Server-rendered HTML — cached so the UI doesn't re-render markdown
   *  on every read. Adapters may regenerate on edit. */
  bodyHtml: string;
  createdAt: string; // ISO 8601
  updatedAt: string;
  /** Parent annotation id for threading. null/undefined = top-level. */
  parentId?: string | null;
  reactions?: AnnotationReaction[];
}

export interface AnnotationAdapter {
  listForNote(noteUuid: string): Promise<Annotation[]>;
  create(input: {
    anchor: AnnotationAnchor;
    bodyMarkdown: string;
    parentId?: string;
    author: CodexUser;
  }): Promise<Annotation>;
  update(id: string, bodyMarkdown: string, author: CodexUser): Promise<Annotation>;
  delete(id: string, author: CodexUser): Promise<void>;
  /** Optional — adapters that support emoji reactions. */
  react?(id: string, emoji: string, user: CodexUser): Promise<void>;
  unreact?(id: string, emoji: string, user: CodexUser): Promise<void>;
}
