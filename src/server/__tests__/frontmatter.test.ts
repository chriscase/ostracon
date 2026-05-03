import { describe, it, expect } from 'vitest';
import { parseNote, serializeNote } from '../frontmatter';

describe('parseNote', () => {
  it('parses YAML frontmatter and content', () => {
    const raw = `---
tags: [product, active]
status: active
repo: chriscase/NexaDeck
---

# NexaDeck

Body text.`;
    const out = parseNote(raw);
    expect(out.data.tags).toEqual(['product', 'active']);
    expect(out.data.status).toBe('active');
    expect(out.data.repo).toBe('chriscase/NexaDeck');
    expect(out.content.startsWith('\n# NexaDeck')).toBe(true);
  });

  it('handles missing frontmatter', () => {
    const raw = '# Just a heading\n\nSome body.';
    const out = parseNote(raw);
    expect(out.data.tags).toEqual([]);
    expect(out.content).toBe(raw);
  });

  it('normalizes string tags into array', () => {
    const raw = `---
tags: meta, decision
---

body`;
    const out = parseNote(raw);
    expect(out.data.tags).toEqual(['meta', 'decision']);
  });

  it('lowercases status', () => {
    const raw = `---
status: ACTIVE
---

body`;
    const out = parseNote(raw);
    expect(out.data.status).toBe('active');
  });

  it('preserves related as array', () => {
    const raw = `---
related: ["[[NexaCore]]", "[[Auth & Licensing]]"]
---

body`;
    const out = parseNote(raw);
    expect(out.data.related).toEqual(['[[NexaCore]]', '[[Auth & Licensing]]']);
  });

  it('parses aliases', () => {
    const raw = `---
aliases: [oldname, alt]
---

body`;
    const out = parseNote(raw);
    expect(out.data.aliases).toEqual(['oldname', 'alt']);
  });
});

describe('serializeNote', () => {
  it('round-trips known fields', () => {
    const raw = `---
tags:
  - product
  - active
status: active
repo: chriscase/NexaDeck
---

# NexaDeck

Body text.
`;
    const parsed = parseNote(raw);
    const serialized = serializeNote(parsed.data, parsed.content);
    const reparsed = parseNote(serialized);
    expect(reparsed.data.tags).toEqual(['product', 'active']);
    expect(reparsed.data.status).toBe('active');
    expect(reparsed.data.repo).toBe('chriscase/NexaDeck');
    expect(reparsed.content).toContain('# NexaDeck');
  });

  it('preserves unknown fields verbatim through round-trip', () => {
    const raw = `---
tags: [meta]
custom_field: some value
nested:
  key: value
---

body
`;
    const parsed = parseNote(raw);
    const serialized = serializeNote(parsed.data, parsed.content);
    const reparsed = parseNote(serialized);
    expect(reparsed.data.custom_field).toBe('some value');
    expect(reparsed.data.nested).toEqual({ key: 'value' });
  });

  it('drops empty arrays from output', () => {
    const serialized = serializeNote(
      { tags: [], aliases: [], status: 'active' },
      '\nbody',
    );
    expect(serialized).not.toContain('tags:');
    expect(serialized).not.toContain('aliases:');
    expect(serialized).toContain('status: active');
  });

  it('drops null and undefined fields from output', () => {
    const serialized = serializeNote(
      { tags: ['a'], status: undefined as unknown as string, repo: null as unknown as string },
      '\nbody',
    );
    expect(serialized).toContain('tags:');
    expect(serialized).not.toContain('status:');
    expect(serialized).not.toContain('repo:');
  });

  it('drops empty-string fields from output', () => {
    const serialized = serializeNote(
      { tags: ['a'], status: '' },
      '\nbody',
    );
    expect(serialized).toContain('tags:');
    expect(serialized).not.toContain('status:');
  });

  it('emits a body-only result when frontmatter is fully empty', () => {
    const serialized = serializeNote({}, '# Just a heading\n');
    expect(serialized).not.toContain('---');
    expect(serialized).toBe('# Just a heading\n');
  });

  it('preserves the leading blank line between frontmatter and body', () => {
    const serialized = serializeNote({ tags: ['a'] }, '\n# Heading\n');
    // gray-matter inserts its own newline after the closing fence; we want
    // the content to start cleanly with the heading.
    expect(serialized).toMatch(/---\n\n# Heading/);
  });
});
