// Vault-wide find-and-replace engine (chriscase/abydonian#226).
//
// The mutation surface is split into two stages:
//   1. previewVaultReplacement — never writes; returns the matches the user
//      can review.
//   2. applyVaultReplacement — under the sync mutex, applies the rewrites
//      and commits in one atomic git operation (or per-file commits if the
//      caller asks for that).
//
// Auto-managed paths (70 - Journals/, 80 - Daily/) are skipped on both the
// preview AND the apply — replace shouldn't ever touch the regions the
// nightly script regenerates.
//
// Wikilink-aware mode: when `wikilinkAware: true`, `query` is interpreted as
// a vault path and we run rewriteWikilinks() per file (the same engine used
// by the rename pipeline). Useful for "replace every reference to old/path
// with new/path".
//
// Otherwise the engine does literal-string or regex find-and-replace inside
// the body content. Frontmatter is not modified by the literal engine —
// edits to frontmatter should go through the form editor.

import { getIndex } from './vault-index';
import { readVaultFile } from './fs';
import { isAutoManagedPath } from './auto-managed';
import { rewriteWikilinks } from './wikilinks';
import { parseNote } from './frontmatter';

export interface FindReplaceQuery {
  /** What to look for. Treated as a regular expression when `regex: true`,
   *  literal substring otherwise. */
  query: string;
  /** What to substitute. For regex, supports `$1` etc. backreferences. */
  replacement: string;
  /** Default false → case-insensitive substring matching. */
  caseSensitive?: boolean;
  /** When true, interpret `query` as a regex. */
  regex?: boolean;
  /** When true, only match whole words (literal mode only — for regex,
   *  the caller can use \b themselves). */
  wholeWord?: boolean;
  /** When true, treat `query` as the OLD vault path of a note and use
   *  rewriteWikilinks() against `replacement` (the NEW vault path).
   *  Mutually exclusive with `regex`. */
  wikilinkAware?: boolean;
  /** Limit to files whose path matches one of these globs (e.g. `20 -*\/.md`).
   *  Empty/undefined means all .md files (excluding auto-managed). */
  pathScope?: string[];
}

export interface PreviewMatch {
  /** Vault-relative path. */
  path: string;
  /** Total occurrences in this file. */
  count: number;
  /** Up to N excerpts (line, column, snippet). */
  excerpts: PreviewExcerpt[];
}

export interface PreviewExcerpt {
  line: number;
  column: number;
  /** ~80-char window around the match. */
  snippet: string;
}

export interface PreviewResult {
  /** Total occurrences across the matched files. */
  totalMatches: number;
  /** Distinct files with at least one match. */
  fileCount: number;
  /** Per-file breakdown (capped — see PREVIEW_FILE_CAP / PREVIEW_EXCERPT_CAP). */
  matches: PreviewMatch[];
  /** True when the match list was truncated by PREVIEW_FILE_CAP. */
  truncated: boolean;
  /** When the user passed `regex: true` and the regex failed to compile,
   *  this captures the error message. The matches array is empty. */
  error?: string;
}

const PREVIEW_FILE_CAP = 100;
const PREVIEW_EXCERPT_CAP = 5;
const SNIPPET_CONTEXT = 40;

/**
 * Build the per-file replacer. Returns a function that, given the file
 * content, yields the rewritten content + match count. Throws if the regex
 * is invalid; caller (preview / apply) should treat that as user error.
 */
export function buildReplacer(
  q: FindReplaceQuery,
): (content: string) => { content: string; count: number } {
  if (q.wikilinkAware) {
    if (q.regex) {
      throw new Error('wikilinkAware and regex modes are mutually exclusive');
    }
    if (!q.query || !q.replacement) {
      throw new Error('wikilinkAware mode requires non-empty query + replacement (the old/new path)');
    }
    return (content) => {
      const r = rewriteWikilinks(content, q.query, q.replacement);
      return { content: r.content, count: r.replacements };
    };
  }
  if (q.regex) {
    let flags = 'g';
    if (!q.caseSensitive) flags += 'i';
    let re: RegExp;
    try {
      re = new RegExp(q.query, flags);
    } catch (err) {
      throw new Error(
        `Invalid regex: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return (content) => {
      let count = 0;
      const next = content.replace(re, (...args) => {
        count++;
        // The Function-replacement form lets us count without losing
        // backreference behavior. Manually pull the match + groups out
        // of the args array (which is `match, p1, p2, ..., offset, str`).
        // Simplest: use the final `groups` arg by re-running .replace
        // wouldn't double-count, but we can also build the replacement
        // string ourselves.
        const matchedString = args[0] as string;
        return q.replacement.replace(/\$(\d+|&)/g, (_m, key) => {
          if (key === '&') return matchedString;
          const groupIdx = Number(key);
          const g = args[groupIdx];
          return typeof g === 'string' ? g : '';
        });
      });
      return { content: next, count };
    };
  }
  // Literal substring or whole-word
  if (!q.query) {
    return (content) => ({ content, count: 0 });
  }
  let flags = 'g';
  if (!q.caseSensitive) flags += 'i';
  const escaped = escapeRegex(q.query);
  const pattern = q.wholeWord ? `\\b${escaped}\\b` : escaped;
  const re = new RegExp(pattern, flags);
  return (content) => {
    let count = 0;
    const next = content.replace(re, () => {
      count++;
      return q.replacement;
    });
    return { content: next, count };
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function pathInScope(rel: string, scope?: string[]): boolean {
  if (!scope || scope.length === 0) return true;
  return scope.some((glob) => globMatch(glob, rel));
}

/**
 * Minimal glob matcher: supports `*` (matches anything except `/`) and `**`
 * (matches anything including `/`). Anchored to the full string. Mirrors
 * the pragmatic subset used by editors / Obsidian / vault tooling — full
 * minimatch isn't worth a dep here.
 */
export function globMatch(glob: string, rel: string): boolean {
  // Compile glob → regex.
  let pattern = '^';
  let i = 0;
  while (i < glob.length) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        pattern += '.*';
        i += 2;
      } else {
        pattern += '[^/]*';
        i += 1;
      }
    } else if (ch === '?') {
      pattern += '[^/]';
      i += 1;
    } else if ('.+^$()|[]{}\\'.includes(ch)) {
      pattern += '\\' + ch;
      i += 1;
    } else {
      pattern += ch;
      i += 1;
    }
  }
  pattern += '$';
  return new RegExp(pattern).test(rel);
}

/**
 * Compute a non-mutating preview. Reads each candidate file from disk,
 * applies the replacer, but discards the rewritten content — only the
 * count + a few excerpts make it into the response.
 */
export async function previewVaultReplacement(q: FindReplaceQuery): Promise<PreviewResult> {
  let replacer: (c: string) => { content: string; count: number };
  try {
    replacer = buildReplacer(q);
  } catch (err) {
    return {
      totalMatches: 0,
      fileCount: 0,
      matches: [],
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const idx = await getIndex();
  const matches: PreviewMatch[] = [];
  let totalMatches = 0;
  let truncated = false;

  for (const [path, meta] of idx.files) {
    if (meta.isAutoManaged) continue;
    if (!pathInScope(path, q.pathScope)) continue;

    let content: string;
    try {
      content = await readVaultFile(path);
    } catch {
      continue;
    }
    const { count } = replacer(content);
    if (count === 0) continue;
    totalMatches += count;

    if (matches.length < PREVIEW_FILE_CAP) {
      matches.push({
        path,
        count,
        excerpts: extractExcerpts(content, q),
      });
    } else {
      truncated = true;
    }
  }

  return {
    totalMatches,
    fileCount: matches.length + (truncated ? 1 : 0), // approximate
    matches,
    truncated,
  };
}

function extractExcerpts(content: string, q: FindReplaceQuery): PreviewExcerpt[] {
  const out: PreviewExcerpt[] = [];
  // Re-derive a search regex matching the same patterns the replacer used,
  // but without invoking the replacement function — we just want match
  // positions for surrounding-context display.
  let re: RegExp;
  try {
    if (q.wikilinkAware) {
      // For wikilink-aware mode, we don't have a clean "single regex" — show
      // a compact summary instead of granular excerpts.
      const escaped = escapeRegex(q.query.replace(/\.md$/i, ''));
      re = new RegExp(`\\[\\[(\\!?)?${escaped}([^\\]]*)?\\]\\]`, 'gi');
    } else if (q.regex) {
      let flags = 'gm';
      if (!q.caseSensitive) flags += 'i';
      re = new RegExp(q.query, flags);
    } else {
      let flags = 'g';
      if (!q.caseSensitive) flags += 'i';
      const esc = escapeRegex(q.query);
      const pattern = q.wholeWord ? `\\b${esc}\\b` : esc;
      re = new RegExp(pattern, flags);
    }
  } catch {
    return out;
  }
  for (const m of content.matchAll(re)) {
    const idx = m.index ?? 0;
    // Compute line + column (1-based for display).
    const before = content.slice(0, idx);
    const line = (before.match(/\n/g)?.length ?? 0) + 1;
    const lineStart = before.lastIndexOf('\n') + 1;
    const column = idx - lineStart + 1;

    const snippetStart = Math.max(0, idx - SNIPPET_CONTEXT);
    const snippetEnd = Math.min(content.length, idx + m[0].length + SNIPPET_CONTEXT);
    const snippet = content
      .slice(snippetStart, snippetEnd)
      .replace(/\n/g, ' ')
      .trim();

    out.push({ line, column, snippet });
    if (out.length >= PREVIEW_EXCERPT_CAP) break;
  }
  return out;
}

export interface ApplyOptions extends FindReplaceQuery {
  author: { name: string; email: string };
  commitMessage?: string;
}

export type ApplyOutcome =
  | {
      kind: 'OK';
      commitSha: string;
      filesChanged: string[];
      totalReplacements: number;
    }
  | { kind: 'INVALID'; reason: string }
  | { kind: 'NOOP'; reason: string };

// Note: applyVaultReplacement lives in sync.ts so it can use the same
// mutex + commit pipeline as every other write. This file only owns the
// pure regex/glob/preview logic. The server-side import is:
//   import { applyVaultReplacement } from '@/lib/codex/sync';

// Re-export the parseNote helper so callers writing their own preview UI
// can split frontmatter from body without touching gray-matter.
export { parseNote };
