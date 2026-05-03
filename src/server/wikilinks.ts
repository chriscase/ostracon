// Obsidian-style wikilink parser + resolver.
// Handles: [[target]], [[target#anchor]], [[target|alias]], [[target#anchor|alias]],
// and embeds: ![[target]] (used for image embeds in _attachments/).

export interface Wikilink {
  target: string;
  anchor?: string;
  alias?: string;
  isEmbed: boolean;
}

const WIKILINK_RE = /(!)?\[\[([^\]|#\n]+)(?:#([^\]|\n]+))?(?:\|([^\]\n]+))?\]\]/g;

export function extractWikilinks(content: string): Wikilink[] {
  const links: Wikilink[] = [];
  for (const m of content.matchAll(WIKILINK_RE)) {
    links.push({
      target: m[2].trim(),
      anchor: m[3]?.trim() || undefined,
      alias: m[4]?.trim() || undefined,
      isEmbed: !!m[1],
    });
  }
  return links;
}

/**
 * Resolve a wikilink target to a relative vault path using Obsidian's
 * shortest-unique-path rule:
 *   1. Strip a trailing .md if present.
 *   2. Match the basename (case-insensitive) against the title index.
 *   3. If the target contains a folder hint (slashes), prefer a path
 *      that contains the hint as a substring.
 *   4. Otherwise return the alphabetically first candidate (deterministic).
 *
 * Returns null if the target has no candidates.
 */
export function resolveWikilink(
  target: string,
  titleIndex: Map<string, string[]>,
): string | null {
  const cleaned = target.replace(/\.md$/i, '').trim();
  if (!cleaned) return null;

  // The title index keys on basename. Pull the basename from the target
  // (strip leading folder hints) for the lookup.
  const lastSlash = cleaned.lastIndexOf('/');
  const basename = lastSlash >= 0 ? cleaned.slice(lastSlash + 1) : cleaned;
  const candidates = titleIndex.get(basename.toLowerCase());
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  if (lastSlash >= 0) {
    const hint = cleaned.toLowerCase();
    const exact = candidates.find((p) => p.toLowerCase().includes(hint));
    if (exact) return exact;
  }
  return [...candidates].sort()[0];
}

export interface RenderedLink {
  match: string;       // full matched substring including [[ ]]
  start: number;
  end: number;
  href: string | null; // resolved relative path, or null if unresolvable
  display: string;     // alias if present, else target basename
  isEmbed: boolean;
  anchor?: string;
}

/**
 * Walk the content and produce one RenderedLink per wikilink occurrence,
 * keyed against the supplied title index. Useful for client-side rendering
 * (Markdown -> HTML with internal links).
 */
export function annotateWikilinks(
  content: string,
  titleIndex: Map<string, string[]>,
): RenderedLink[] {
  const out: RenderedLink[] = [];
  for (const m of content.matchAll(WIKILINK_RE)) {
    const target = m[2].trim();
    const anchor = m[3]?.trim() || undefined;
    const alias = m[4]?.trim() || undefined;
    const isEmbed = !!m[1];
    const href = resolveWikilink(target, titleIndex);
    const lastSlash = target.lastIndexOf('/');
    const basename = lastSlash >= 0 ? target.slice(lastSlash + 1) : target;
    out.push({
      match: m[0],
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
      href,
      display: alias ?? basename,
      isEmbed,
      anchor,
    });
  }
  return out;
}

// ─── Rewriter (chriscase/abydonian#212) ───────────────────────────────────
//
// Rename support: when a vault path moves from `oldPath` → `newPath`, every
// wikilink in every other note that resolves to `oldPath` must be rewritten
// so backlinks survive. Without this, every rename silently breaks N inbound
// links — the worst kind of bug.
//
// Resolution policy: match the wikilink target against four normalized forms
// of `oldPath` (full path with / without `.md`, basename with / without
// `.md`). The replacement uses the matching form of `newPath`, preserving
// the user's specificity choice (folder-hinted vs basename-only). Anchors
// and aliases are preserved verbatim.
//
// Skip ranges: fenced code blocks, inline code spans, and HTML comments are
// excluded from rewriting — the regex would otherwise corrupt code samples.

function basenameNoExt(p: string): string {
  const stripped = p.replace(/\.md$/i, '');
  const slash = stripped.lastIndexOf('/');
  return slash >= 0 ? stripped.slice(slash + 1) : stripped;
}

function pathNoExt(p: string): string {
  return p.replace(/\.md$/i, '');
}

/**
 * Compute the half-open byte ranges in `content` that the rewriter must NOT
 * touch: fenced code blocks (``` or ~~~), inline code spans (`...`), and
 * HTML comments (<!-- ... -->). Wikilink-shaped text inside these is part
 * of someone's example; rewriting it would corrupt the example.
 */
function computeNoRewriteRanges(content: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];

  // Pass 1: fenced code blocks. Matches the opening and closing fence and
  // everything between, including the trailing newline of the closing fence.
  const lines = content.split('\n');
  let charPos = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fenceMatch = line.match(/^([ \t]*)(```+|~~~+)/);
    if (fenceMatch) {
      const fenceMarker = fenceMatch[2][0]; // ` or ~
      const fenceLen = fenceMatch[2].length;
      const startCharPos = charPos;
      // Advance past opening line.
      charPos += line.length + 1;
      i++;
      // Find closing fence (same marker, length >= opening).
      while (i < lines.length) {
        const closeLine = lines[i];
        const escaped = fenceMarker === '`' ? '`' : '~';
        const closeRe = new RegExp(`^[ \\t]*${escaped}{${fenceLen},}\\s*$`);
        if (closeRe.test(closeLine)) {
          charPos += closeLine.length + 1;
          i++;
          break;
        }
        charPos += closeLine.length + 1;
        i++;
      }
      // Whether closed or EOF, mark the whole region as skip (no-closer is
      // malformed markdown but treating the rest as code is the safer bet
      // — better to under-rewrite than corrupt a code sample).
      ranges.push([startCharPos, Math.min(charPos, content.length)]);
      continue;
    }
    charPos += line.length + 1;
    i++;
  }

  const isInRanges = (pos: number) => ranges.some(([s, e]) => pos >= s && pos < e);

  // Pass 2: inline code spans. Single-backtick spans are the common form;
  // double/triple backtick spans (` ``code`` `) are rare in practice but
  // handled by the same backtick-counting rule. We match a run of N
  // backticks, content (no newline), then the same run.
  const inlineRe = /(`+)(?!`)([^\n]*?)(?<!`)\1(?!`)/g;
  for (const m of content.matchAll(inlineRe)) {
    const pos = m.index!;
    if (!isInRanges(pos)) {
      ranges.push([pos, pos + m[0].length]);
    }
  }

  // Pass 3: HTML comments. Wikilinks in comments are usually intentional
  // (notes the author wrote about deprecated link forms, etc.) — skip them.
  const commentRe = /<!--[\s\S]*?-->/g;
  for (const m of content.matchAll(commentRe)) {
    const pos = m.index!;
    if (!isInRanges(pos)) {
      ranges.push([pos, pos + m[0].length]);
    }
  }

  return ranges;
}

export interface RewriteResult {
  content: string;
  replacements: number;
}

/**
 * Rewrite every wikilink in `content` that resolves to `oldPath` so it now
 * resolves to `newPath`. Handles all six wikilink forms documented above,
 * preserves anchors and aliases verbatim, and skips text inside code blocks
 * / code spans / HTML comments.
 *
 * The function does NOT consult a title index — it does string matching
 * against four normalized forms of `oldPath`. Callers that need the
 * shortest-unique-path resolution to *upgrade* a basename-only link to a
 * folder-hinted link (because the new path's basename now collides with
 * another note) should detect the collision themselves and pass the
 * already-folder-hinted form. v1 of the rewriter preserves whichever form
 * the user originally wrote.
 *
 * @param content  Full file content (frontmatter + body)
 * @param oldPath  Vault-relative path being renamed FROM (e.g. `20 - Products/NexaDeck.md`)
 * @param newPath  Vault-relative path being renamed TO (e.g. `20 - Products/NexaDeckPro.md`)
 * @returns        Rewritten content and the number of wikilinks replaced
 */
export function rewriteWikilinks(
  content: string,
  oldPath: string,
  newPath: string,
): RewriteResult {
  if (!oldPath || !newPath || oldPath === newPath) {
    return { content, replacements: 0 };
  }

  const oldFull = oldPath;
  const oldNoExt = pathNoExt(oldPath);
  const oldBaseFull = basenameNoExt(oldPath) + '.md';
  const oldBase = basenameNoExt(oldPath);

  const newFull = newPath;
  const newNoExt = pathNoExt(newPath);
  const newBaseFull = basenameNoExt(newPath) + '.md';
  const newBase = basenameNoExt(newPath);

  // Lowercase variants for case-insensitive comparison (Obsidian resolves
  // wikilinks case-insensitively against the basename).
  const oldFullLc = oldFull.toLowerCase();
  const oldNoExtLc = oldNoExt.toLowerCase();
  const oldBaseFullLc = oldBaseFull.toLowerCase();
  const oldBaseLc = oldBase.toLowerCase();

  const skipRanges = computeNoRewriteRanges(content);
  const isInSkip = (pos: number) =>
    skipRanges.some(([s, e]) => pos >= s && pos < e);

  let lastEnd = 0;
  const out: string[] = [];
  let replacements = 0;

  for (const m of content.matchAll(WIKILINK_RE)) {
    const start = m.index!;
    const end = start + m[0].length;
    if (isInSkip(start)) continue;

    const isEmbed = !!m[1];
    const rawTarget = m[2];
    const rawAnchor = m[3]; // may be undefined
    const rawAlias = m[4];  // may be undefined

    const trimmed = rawTarget.trim();
    const trimmedLc = trimmed.toLowerCase();

    let newTarget: string | null = null;
    if (trimmedLc === oldFullLc) newTarget = newFull;
    else if (trimmedLc === oldNoExtLc) newTarget = newNoExt;
    else if (trimmedLc === oldBaseFullLc) newTarget = newBaseFull;
    else if (trimmedLc === oldBaseLc) newTarget = newBase;

    if (newTarget === null) continue;

    // Preserve any leading/trailing whitespace inside the [[...]] target slot.
    const leadWs = rawTarget.match(/^\s*/)![0];
    const trailWs = rawTarget.match(/\s*$/)![0];

    let rebuilt = (isEmbed ? '![[' : '[[') + leadWs + newTarget + trailWs;
    if (rawAnchor !== undefined) rebuilt += '#' + rawAnchor;
    if (rawAlias !== undefined) rebuilt += '|' + rawAlias;
    rebuilt += ']]';

    out.push(content.slice(lastEnd, start));
    out.push(rebuilt);
    lastEnd = end;
    replacements++;
  }

  if (replacements === 0) {
    return { content, replacements: 0 };
  }

  out.push(content.slice(lastEnd));
  return { content: out.join(''), replacements };
}
