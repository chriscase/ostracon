// Title + tag + path + body search over the vault index.
// PR 1 added title/tag/path; PR 3 (this) extends to body content using the
// `body` field added to NoteMeta when the index started tracking content sha
// for optimistic concurrency.

import { getIndex, type NoteMeta } from './vault-index';

export interface SearchHit {
  meta: NoteMeta;
  score: number;
  matchedOn: 'title' | 'tag' | 'path' | 'body';
  /** Body excerpt around the first match — present only when matchedOn==='body'. */
  excerpt?: string;
}

function scoreMatch(haystack: string, needle: string): number {
  if (!haystack) return 0;
  const h = haystack.toLowerCase();
  if (h === needle) return 100;
  if (h.startsWith(needle)) return 60;
  const idx = h.indexOf(needle);
  if (idx >= 0) {
    // Earlier matches score higher.
    return Math.max(20, 40 - idx);
  }
  return 0;
}

export async function searchVault(query: string, limit = 20): Promise<SearchHit[]> {
  const q = query.toLowerCase().trim();
  if (!q) return [];

  const idx = await getIndex();
  const hits: SearchHit[] = [];

  for (const meta of idx.files.values()) {
    const titleScore = scoreMatch(meta.title, q);
    let bestScore = 0;
    let matchedOn: SearchHit['matchedOn'] = 'path';

    if (titleScore > 0) {
      bestScore = titleScore;
      matchedOn = 'title';
    }

    for (const tag of meta.tags) {
      const ts = scoreMatch(tag, q);
      if (ts > bestScore) {
        bestScore = ts;
        matchedOn = 'tag';
      }
    }

    // Path match falls back to lower priority (folder hits, e.g., "Daily").
    const pathScore = scoreMatch(meta.path, q);
    if (pathScore > bestScore) {
      bestScore = Math.min(pathScore, 30);
      matchedOn = 'path';
    }

    // Body content match — only kicks in if nothing better has matched.
    // We score lower than title/tag so a "title hit" always outranks a "body hit".
    let excerpt: string | undefined;
    if (bestScore === 0 && meta.body) {
      const lowerBody = meta.body.toLowerCase();
      const bodyIdx = lowerBody.indexOf(q);
      if (bodyIdx >= 0) {
        bestScore = 25;
        matchedOn = 'body';
        excerpt = makeExcerpt(meta.body, bodyIdx, q.length);
      }
    }

    if (bestScore > 0) {
      const hit: SearchHit = { meta, score: bestScore, matchedOn };
      if (excerpt !== undefined) hit.excerpt = excerpt;
      hits.push(hit);
    }
  }

  hits.sort((a, b) => b.score - a.score || a.meta.path.localeCompare(b.meta.path));
  return hits.slice(0, limit);
}

function makeExcerpt(body: string, matchIdx: number, matchLen: number): string {
  const start = Math.max(0, matchIdx - 30);
  const end = Math.min(body.length, matchIdx + matchLen + 30);
  const slice = body.slice(start, end).replace(/\s+/g, ' ').trim();
  const prefix = start > 0 ? '…' : '';
  const suffix = end < body.length ? '…' : '';
  return `${prefix}${slice}${suffix}`;
}
