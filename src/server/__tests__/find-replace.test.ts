// Tests for the find-replace engine (chriscase/abydonian#226).
// These cover the pure regex/glob/build-replacer logic; the apply path
// (which writes + commits) is exercised by the sync tests.

import { describe, it, expect } from 'vitest';
import { buildReplacer, globMatch } from '../find-replace';

describe('buildReplacer — literal mode', () => {
  it('replaces all occurrences case-insensitively by default', () => {
    const replace = buildReplacer({ query: 'foo', replacement: 'bar' });
    const r = replace('Foo and FOO and foo.');
    expect(r.count).toBe(3);
    expect(r.content).toBe('bar and bar and bar.');
  });

  it('respects caseSensitive: true', () => {
    const replace = buildReplacer({
      query: 'foo',
      replacement: 'bar',
      caseSensitive: true,
    });
    const r = replace('Foo and FOO and foo.');
    expect(r.count).toBe(1);
    expect(r.content).toBe('Foo and FOO and bar.');
  });

  it('escapes regex metacharacters in literal mode', () => {
    const replace = buildReplacer({
      query: '.*?',
      replacement: 'X',
    });
    const r = replace('match .*? but not abc');
    expect(r.count).toBe(1);
    expect(r.content).toBe('match X but not abc');
  });

  it('honors wholeWord by adding word-boundary anchors', () => {
    const replace = buildReplacer({
      query: 'cat',
      replacement: 'dog',
      wholeWord: true,
    });
    const r = replace('cat catalog category cat');
    expect(r.count).toBe(2);
    expect(r.content).toBe('dog catalog category dog');
  });

  it('returns 0 when query is empty', () => {
    const replace = buildReplacer({ query: '', replacement: 'X' });
    const r = replace('hello');
    expect(r.count).toBe(0);
    expect(r.content).toBe('hello');
  });
});

describe('buildReplacer — regex mode', () => {
  it('supports backreferences', () => {
    const replace = buildReplacer({
      query: '(\\w+)@(\\w+)',
      replacement: '$2 at $1',
      regex: true,
    });
    const r = replace('alice@example bob@host');
    expect(r.count).toBe(2);
    expect(r.content).toBe('example at alice host at bob');
  });

  it('preserves $& as the matched substring', () => {
    const replace = buildReplacer({
      query: '\\d+',
      replacement: '<$&>',
      regex: true,
    });
    const r = replace('item 12 and 345');
    expect(r.count).toBe(2);
    expect(r.content).toBe('item <12> and <345>');
  });

  it('throws on invalid regex', () => {
    expect(() =>
      buildReplacer({
        query: '[unterminated',
        replacement: '',
        regex: true,
      }),
    ).toThrow(/Invalid regex/);
  });
});

describe('buildReplacer — wikilink-aware mode', () => {
  it('rewrites every wikilink form between two paths', () => {
    const replace = buildReplacer({
      query: '20 - Products/Foo.md',
      replacement: '20 - Products/Bar.md',
      wikilinkAware: true,
    });
    const content =
      'See [[Foo]] and [[Foo|the foo]] and [[20 - Products/Foo]] and ![[Foo]].';
    const r = replace(content);
    expect(r.count).toBe(4);
    expect(r.content).toContain('[[Bar]]');
    expect(r.content).toContain('[[Bar|the foo]]');
    expect(r.content).toContain('[[20 - Products/Bar]]');
    expect(r.content).toContain('![[Bar]]');
  });

  it('refuses to combine with regex mode', () => {
    expect(() =>
      buildReplacer({
        query: 'foo',
        replacement: 'bar',
        wikilinkAware: true,
        regex: true,
      }),
    ).toThrow(/mutually exclusive/);
  });

  it('refuses with empty query or replacement', () => {
    expect(() =>
      buildReplacer({ query: '', replacement: 'x', wikilinkAware: true }),
    ).toThrow(/non-empty/);
    expect(() =>
      buildReplacer({ query: 'x', replacement: '', wikilinkAware: true }),
    ).toThrow(/non-empty/);
  });
});

describe('globMatch', () => {
  it('matches an exact literal', () => {
    expect(globMatch('foo.md', 'foo.md')).toBe(true);
    expect(globMatch('foo.md', 'bar.md')).toBe(false);
  });

  it('* matches anything except slash', () => {
    expect(globMatch('20 - Products/*.md', '20 - Products/Note.md')).toBe(true);
    expect(globMatch('20 - Products/*.md', '20 - Products/Sub/Note.md')).toBe(false);
  });

  it('** matches across slashes', () => {
    expect(globMatch('20 - Products/**/*.md', '20 - Products/Sub/Note.md')).toBe(true);
    expect(globMatch('**/*.md', '40 - Concepts/Deep/Note.md')).toBe(true);
  });

  it('? matches a single non-slash character', () => {
    expect(globMatch('?.md', 'a.md')).toBe(true);
    expect(globMatch('?.md', 'ab.md')).toBe(false);
    expect(globMatch('?.md', '/.md')).toBe(false);
  });

  it('escapes regex metacharacters', () => {
    expect(globMatch('20 - Products/Foo (final).md', '20 - Products/Foo (final).md')).toBe(true);
    // Without the escape, "(final)" would be a regex group and "Foo X.md" would
    // accidentally match. Confirm it doesn't.
    expect(globMatch('20 - Products/Foo (final).md', '20 - Products/Foo X.md')).toBe(false);
  });
});
