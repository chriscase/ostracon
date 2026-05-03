import { describe, it, expect } from 'vitest';
import {
  extractWikilinks,
  resolveWikilink,
  annotateWikilinks,
  rewriteWikilinks,
} from '../wikilinks';

describe('extractWikilinks', () => {
  it('extracts a plain wikilink', () => {
    const links = extractWikilinks('See [[NexaDeck]] for details.');
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({
      target: 'NexaDeck',
      isEmbed: false,
    });
    expect(links[0].alias).toBeUndefined();
    expect(links[0].anchor).toBeUndefined();
  });

  it('extracts a wikilink with anchor and alias', () => {
    const links = extractWikilinks('refer to [[Auth & Licensing#JWT|the JWT section]]');
    expect(links[0]).toMatchObject({
      target: 'Auth & Licensing',
      anchor: 'JWT',
      alias: 'the JWT section',
      isEmbed: false,
    });
  });

  it('extracts an embed', () => {
    const links = extractWikilinks('![[diagram.png]]');
    expect(links[0]).toMatchObject({
      target: 'diagram.png',
      isEmbed: true,
    });
  });

  it('extracts multiple links from a paragraph', () => {
    const text = 'Both [[NexaDeck]] and [[NexaLive]] talk to [[NexaCore]].';
    expect(extractWikilinks(text).map((l) => l.target)).toEqual([
      'NexaDeck',
      'NexaLive',
      'NexaCore',
    ]);
  });

  it('does not match malformed brackets', () => {
    expect(extractWikilinks('not a link [single]')).toHaveLength(0);
    expect(extractWikilinks('not a link [[no closer')).toHaveLength(0);
  });
});

describe('resolveWikilink', () => {
  const idx = new Map<string, string[]>([
    ['nexadeck', ['20 - Products/NexaDeck.md']],
    ['nexacore', ['20 - Products/NexaCore.md']],
    ['shared', ['30 - Architecture/shared.md', '40 - Concepts/shared.md']],
  ]);

  it('resolves an unambiguous basename', () => {
    expect(resolveWikilink('NexaDeck', idx)).toBe('20 - Products/NexaDeck.md');
  });

  it('returns null for missing targets', () => {
    expect(resolveWikilink('NotARealNote', idx)).toBeNull();
  });

  it('strips trailing .md', () => {
    expect(resolveWikilink('NexaDeck.md', idx)).toBe('20 - Products/NexaDeck.md');
  });

  it('disambiguates with a folder hint', () => {
    expect(
      resolveWikilink('30 - Architecture/shared', idx),
    ).toBe('30 - Architecture/shared.md');
    expect(
      resolveWikilink('40 - Concepts/shared', idx),
    ).toBe('40 - Concepts/shared.md');
  });

  it('falls back to alphabetical first when ambiguous', () => {
    expect(resolveWikilink('shared', idx)).toBe('30 - Architecture/shared.md');
  });
});

describe('annotateWikilinks', () => {
  const idx = new Map<string, string[]>([
    ['nexadeck', ['20 - Products/NexaDeck.md']],
  ]);

  it('produces resolved hrefs and display text', () => {
    const ann = annotateWikilinks('See [[NexaDeck|the deck]] now.', idx);
    expect(ann).toHaveLength(1);
    expect(ann[0].href).toBe('20 - Products/NexaDeck.md');
    expect(ann[0].display).toBe('the deck');
    expect(ann[0].isEmbed).toBe(false);
  });

  it('flags unresolved links with null href', () => {
    const ann = annotateWikilinks('[[Ghost]]', idx);
    expect(ann[0].href).toBeNull();
    expect(ann[0].display).toBe('Ghost');
  });
});

describe('rewriteWikilinks', () => {
  const oldPath = '20 - Products/NexaDeck.md';
  const newPath = '20 - Products/NexaDeckPro.md';

  // ─── Form coverage (the six wikilink shapes) ─────────────────────────

  it('rewrites a plain basename wikilink', () => {
    const result = rewriteWikilinks('See [[NexaDeck]] for details.', oldPath, newPath);
    expect(result.replacements).toBe(1);
    expect(result.content).toBe('See [[NexaDeckPro]] for details.');
  });

  it('rewrites a wikilink with an alias and preserves the alias text verbatim', () => {
    const result = rewriteWikilinks(
      'See [[NexaDeck|the karaoke app]] for details.',
      oldPath,
      newPath,
    );
    expect(result.replacements).toBe(1);
    expect(result.content).toBe('See [[NexaDeckPro|the karaoke app]] for details.');
  });

  it('rewrites a wikilink with a section anchor and preserves the anchor verbatim', () => {
    const result = rewriteWikilinks(
      'See [[NexaDeck#Architecture]] for details.',
      oldPath,
      newPath,
    );
    expect(result.replacements).toBe(1);
    expect(result.content).toBe('See [[NexaDeckPro#Architecture]] for details.');
  });

  it('rewrites a wikilink with both anchor and alias', () => {
    const result = rewriteWikilinks(
      'See [[NexaDeck#Architecture|the architecture section]] for details.',
      oldPath,
      newPath,
    );
    expect(result.replacements).toBe(1);
    expect(result.content).toBe(
      'See [[NexaDeckPro#Architecture|the architecture section]] for details.',
    );
  });

  it('rewrites an embed', () => {
    const result = rewriteWikilinks('![[NexaDeck]]', oldPath, newPath);
    expect(result.replacements).toBe(1);
    expect(result.content).toBe('![[NexaDeckPro]]');
  });

  it('rewrites an embed with an anchor', () => {
    const result = rewriteWikilinks(
      'See ![[NexaDeck#Stack]] inline.',
      oldPath,
      newPath,
    );
    expect(result.replacements).toBe(1);
    expect(result.content).toBe('See ![[NexaDeckPro#Stack]] inline.');
  });

  // ─── Path-form coverage (basename, full path, with/without .md) ──────

  it('rewrites a folder-hinted target and preserves the new folder hint', () => {
    const result = rewriteWikilinks(
      'See [[20 - Products/NexaDeck]] for details.',
      oldPath,
      newPath,
    );
    expect(result.replacements).toBe(1);
    expect(result.content).toBe('See [[20 - Products/NexaDeckPro]] for details.');
  });

  it('rewrites a folder-hinted target with explicit .md', () => {
    const result = rewriteWikilinks(
      'See [[20 - Products/NexaDeck.md]] for details.',
      oldPath,
      newPath,
    );
    expect(result.replacements).toBe(1);
    expect(result.content).toBe('See [[20 - Products/NexaDeckPro.md]] for details.');
  });

  it('rewrites a basename target with explicit .md', () => {
    const result = rewriteWikilinks(
      'See [[NexaDeck.md]] for details.',
      oldPath,
      newPath,
    );
    expect(result.replacements).toBe(1);
    expect(result.content).toBe('See [[NexaDeckPro.md]] for details.');
  });

  it('matches case-insensitively but emits the new path with its original casing', () => {
    const result = rewriteWikilinks('See [[nexadeck]] please.', oldPath, newPath);
    expect(result.replacements).toBe(1);
    expect(result.content).toBe('See [[NexaDeckPro]] please.');
  });

  // ─── Multi-match + counting ──────────────────────────────────────────

  it('rewrites multiple occurrences in one pass and reports the correct count', () => {
    const input =
      'Both [[NexaDeck]] and [[NexaDeck|the deck]] reference [[20 - Products/NexaDeck#Stack]].';
    const result = rewriteWikilinks(input, oldPath, newPath);
    expect(result.replacements).toBe(3);
    expect(result.content).toBe(
      'Both [[NexaDeckPro]] and [[NexaDeckPro|the deck]] reference [[20 - Products/NexaDeckPro#Stack]].',
    );
  });

  it('leaves unrelated wikilinks alone', () => {
    const input = '[[NexaDeck]] and [[NexaLive]] and [[NexaCore]]';
    const result = rewriteWikilinks(input, oldPath, newPath);
    expect(result.replacements).toBe(1);
    expect(result.content).toBe('[[NexaDeckPro]] and [[NexaLive]] and [[NexaCore]]');
  });

  // ─── No-match path returns unchanged content + 0 ─────────────────────

  it('returns 0 replacements and unchanged content when nothing matches', () => {
    const input = 'See [[NexaLive]] for details.';
    const result = rewriteWikilinks(input, oldPath, newPath);
    expect(result.replacements).toBe(0);
    expect(result.content).toBe(input);
  });

  it('returns 0 replacements and unchanged content when there are no wikilinks at all', () => {
    const input = 'No wikilinks here, just plain prose.';
    const result = rewriteWikilinks(input, oldPath, newPath);
    expect(result.replacements).toBe(0);
    expect(result.content).toBe(input);
  });

  it('returns 0 replacements when oldPath equals newPath', () => {
    const input = 'See [[NexaDeck]] for details.';
    const result = rewriteWikilinks(input, oldPath, oldPath);
    expect(result.replacements).toBe(0);
    expect(result.content).toBe(input);
  });

  // ─── Code block / code span / HTML comment skip ──────────────────────

  it('does not rewrite inside a fenced code block', () => {
    const input = [
      'Real link: [[NexaDeck]]',
      '',
      '```ts',
      "// example: [[NexaDeck]] is the karaoke app",
      'const x = "[[NexaDeck]]";',
      '```',
      '',
      'And another real one: [[NexaDeck|deck]]',
    ].join('\n');
    const result = rewriteWikilinks(input, oldPath, newPath);
    expect(result.replacements).toBe(2);
    // Inside the fenced block, the wikilinks remain untouched.
    expect(result.content).toContain("// example: [[NexaDeck]] is the karaoke app");
    expect(result.content).toContain('const x = "[[NexaDeck]]";');
    // Outside, both real links got rewritten.
    expect(result.content.startsWith('Real link: [[NexaDeckPro]]')).toBe(true);
    expect(result.content).toContain('And another real one: [[NexaDeckPro|deck]]');
  });

  it('does not rewrite inside an inline code span', () => {
    const input = 'Use `[[NexaDeck]]` to link, e.g. [[NexaDeck]].';
    const result = rewriteWikilinks(input, oldPath, newPath);
    expect(result.replacements).toBe(1);
    expect(result.content).toBe('Use `[[NexaDeck]]` to link, e.g. [[NexaDeckPro]].');
  });

  it('does not rewrite inside an HTML comment', () => {
    const input = '<!-- TODO: link to [[NexaDeck]] later -->\nReal: [[NexaDeck]]';
    const result = rewriteWikilinks(input, oldPath, newPath);
    expect(result.replacements).toBe(1);
    expect(result.content).toBe(
      '<!-- TODO: link to [[NexaDeck]] later -->\nReal: [[NexaDeckPro]]',
    );
  });

  it('handles tilde-fenced code blocks', () => {
    const input = [
      'Real: [[NexaDeck]]',
      '~~~',
      '[[NexaDeck]] in tildes',
      '~~~',
      'Also: [[NexaDeck]]',
    ].join('\n');
    const result = rewriteWikilinks(input, oldPath, newPath);
    expect(result.replacements).toBe(2);
    expect(result.content).toContain('[[NexaDeck]] in tildes');
    expect(result.content).toMatch(/^Real: \[\[NexaDeckPro\]\]/);
    expect(result.content).toContain('Also: [[NexaDeckPro]]');
  });

  // ─── Cross-folder rename ──────────────────────────────────────────────

  it('rewrites folder-hinted links across a folder change', () => {
    const result = rewriteWikilinks(
      'See [[20 - Products/NexaDeck]] for details.',
      '20 - Products/NexaDeck.md',
      '30 - Architecture/NexaDeck.md',
    );
    expect(result.replacements).toBe(1);
    expect(result.content).toBe('See [[30 - Architecture/NexaDeck]] for details.');
  });

  it('preserves leading/trailing whitespace inside the target slot', () => {
    const result = rewriteWikilinks('See [[ NexaDeck ]] now.', oldPath, newPath);
    expect(result.replacements).toBe(1);
    expect(result.content).toBe('See [[ NexaDeckPro ]] now.');
  });
});
