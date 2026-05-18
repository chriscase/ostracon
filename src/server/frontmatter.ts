// Frontmatter parsing + serialization for AbydosCodex notes.
// Wraps gray-matter and normalizes the small set of conventions used in the vault
// (see AbydosCodex/00 - Meta/Conventions.md).

import matter from 'gray-matter';

export interface Frontmatter {
  tags?: string[];
  status?: string;
  repo?: string;
  date?: string;
  created?: string;
  aliases?: string[];
  related?: string[];
  /** Stable note identifier — injected by saveNote when missing, survives
   *  renames/moves. Anchor for DB-backed features (comments, annotations,
   *  embeddings, audit log). v7 UUID by default; existing values preserved
   *  on round-trip even if they aren't v7. */
  uuid?: string;
  // Auto-managed fields written by _scripts/nightly-journal.py
  last_mined?: string;
  [key: string]: unknown;
}

export interface ParsedNote {
  data: Frontmatter;
  content: string;
  raw: string;
}

export function parseNote(raw: string): ParsedNote {
  const parsed = matter(raw);
  return {
    data: normalizeFrontmatter(parsed.data ?? {}),
    content: parsed.content,
    raw,
  };
}

function normalizeFrontmatter(data: Record<string, unknown>): Frontmatter {
  const out: Frontmatter = { ...data };

  // Tags: array preferred, but tolerate "a, b, c" or single string
  if (Array.isArray(data.tags)) {
    out.tags = data.tags.map(String);
  } else if (typeof data.tags === 'string') {
    out.tags = data.tags
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
  } else {
    out.tags = [];
  }

  // Aliases: same shape rules as tags
  if (Array.isArray(data.aliases)) {
    out.aliases = data.aliases.map(String);
  } else if (typeof data.aliases === 'string') {
    out.aliases = data.aliases
      .split(/[,\s]+/)
      .map((t) => t.trim())
      .filter(Boolean);
  }

  // Related: array of "[[wikilink]]" strings
  if (Array.isArray(data.related)) {
    out.related = data.related.map(String);
  }

  // Status: string, lowercase to canonicalize
  if (typeof data.status === 'string') {
    out.status = data.status.toLowerCase().trim();
  }

  return out;
}

/**
 * Serialize a Frontmatter object + body content back to a vault-ready
 * markdown string. The result round-trips through `parseNote()` for known
 * fields; unknown fields pass through unchanged.
 *
 * Empty arrays, empty strings, null, and undefined are dropped from the
 * frontmatter (so an "empty" note doesn't carry a noisy `tags: []` line).
 *
 * Body content is normalized: a single leading newline separates the
 * frontmatter from the body, matching the convention used by the rest of
 * the vault and what Obsidian writes by default.
 */
export function serializeNote(data: Frontmatter, content: string): string {
  const cleaned = stripEmptyFields(data);

  // gray-matter's stringify takes (content, data) — yes, the order is the
  // mirror of parse. It returns "---\n<yaml>\n---\n<content>" with a single
  // newline between the closing fence and the content. Our notes consistently
  // start the body with a blank line after the frontmatter (so headings have
  // breathing room); preserve that by ensuring `content` starts with `\n`.
  const body = content.startsWith('\n') ? content : '\n' + content;

  // If the cleaned frontmatter is empty, gray-matter would emit a literal
  // "---\n---\n" which is ugly. Skip the fences in that case and just emit
  // the body as-is.
  if (Object.keys(cleaned).length === 0) {
    return body.replace(/^\n/, '');
  }

  return matter.stringify(body, cleaned);
}

function stripEmptyFields(data: Frontmatter): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    out[key] = value;
  }
  return out;
}

/** Default vault status options. Overridden per-vault eventually. */
export const DEFAULT_STATUS_OPTIONS: ReadonlyArray<string> = [
  'active',
  'paused',
  'archived',
  'stub',
  'ported',
];
