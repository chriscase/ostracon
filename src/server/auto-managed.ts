// Detector for the `## Activity` auto-managed region in journal/daily notes.
// Mirrors AbydosCodex/_scripts/nightly-journal.py:166 (ACTIVITY_RE) so the
// admin editor and the nightly miner agree on region boundaries.
//
// Region:  newline + "## Activity" + rest-of-heading-line + body up to the
//          next "## " heading or end-of-file.

const ACTIVITY_RE = /\n## Activity[^\n]*\n(?:.*?\n)*?(?=\n## |$)/s;

export interface AutoSplit {
  before: string;
  autoRegion: string | null;
  after: string;
}

export function splitAutoRegion(content: string): AutoSplit {
  const match = content.match(ACTIVITY_RE);
  if (!match || match.index === undefined) {
    return { before: content, autoRegion: null, after: '' };
  }
  return {
    before: content.slice(0, match.index),
    autoRegion: match[0],
    after: content.slice(match.index + match[0].length),
  };
}

export function hasAutoRegion(content: string): boolean {
  return ACTIVITY_RE.test(content);
}

export function replaceAutoRegion(original: string, newAutoRegion: string): string {
  if (ACTIVITY_RE.test(original)) {
    return original.replace(ACTIVITY_RE, newAutoRegion);
  }
  return original;
}

/**
 * Auto-managed paths: notes whose `## Activity` section is overwritten nightly.
 * Used to flag tree entries and editor banners.
 */
export function isAutoManagedPath(rel: string): boolean {
  return /^70 - Journals|^80 - Daily/.test(rel);
}
