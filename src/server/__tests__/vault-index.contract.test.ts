// Contract tests for the vault index — focused on the title-index surface
// that resolveWikilink() reads against. Filesystem-backed because the index
// is built by walking the vault root; building it from in-memory fixtures
// would bypass the walk-and-parse step that this contract is asserting.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { getIndex, invalidateIndex } from '../vault-index';
import { resolveWikilink } from '../wikilinks';

let tmpRoot: string;
let originalEnv: string | undefined;

beforeAll(async () => {
  tmpRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'codex-vault-index-')),
  );
  await fs.mkdir(path.join(tmpRoot, 'concepts'), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, 'products'), { recursive: true });

  // A concept page that exposes two alias strings.
  await fs.writeFile(
    path.join(tmpRoot, 'concepts', 'Foo.md'),
    `---
aliases: [Bar, Baz]
---
# Foo
Body content.`,
  );

  // A note whose body wikilinks the alias — wired in so that the edge
  // builder exercises alias resolution too (not just the title map).
  await fs.writeFile(
    path.join(tmpRoot, 'products', 'Other.md'),
    `---
tags: [product]
---
# Other
References [[Bar]] by alias and [[Foo]] by filename.`,
  );

  // A second note that aliases the same string — collision case.
  await fs.writeFile(
    path.join(tmpRoot, 'concepts', 'Quux.md'),
    `---
aliases: [Bar]
---
# Quux
Also claims the Bar alias.`,
  );

  // A filename that collides with an alias on Foo, to confirm aliases
  // and filenames share the same lookup space.
  await fs.writeFile(
    path.join(tmpRoot, 'products', 'Baz.md'),
    `---
tags: [product]
---
# Baz
Real file named Baz.`,
  );

  originalEnv = process.env.ABYDOS_VAULT_PATH;
  process.env.ABYDOS_VAULT_PATH = tmpRoot;
});

beforeEach(() => {
  invalidateIndex();
});

afterAll(async () => {
  if (originalEnv === undefined) {
    delete process.env.ABYDOS_VAULT_PATH;
  } else {
    process.env.ABYDOS_VAULT_PATH = originalEnv;
  }
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('vault index — frontmatter alias resolution', () => {
  it('resolves a wikilink to a frontmatter alias', async () => {
    const idx = await getIndex();
    expect(resolveWikilink('Bar', idx.titles)).toContain('Foo.md');
  });

  it('resolves every alias in the aliases array', async () => {
    const idx = await getIndex();
    // 'Baz' is also an alias on Foo, but there is also a real Baz.md file —
    // resolveWikilink's alphabetical-first fallback picks the products/Baz.md
    // path. The contract here is just that Foo.md is among the candidates.
    expect(idx.titles.get('baz')).toContain('concepts/Foo.md');
    expect(idx.titles.get('baz')).toContain('products/Baz.md');
  });

  it('matches aliases case-insensitively', async () => {
    const idx = await getIndex();
    expect(resolveWikilink('bar', idx.titles)).not.toBeNull();
    expect(resolveWikilink('BAR', idx.titles)).not.toBeNull();
  });

  it('multi-alias collisions surface every candidate', async () => {
    const idx = await getIndex();
    const candidates = idx.titles.get('bar') ?? [];
    expect(candidates).toContain('concepts/Foo.md');
    expect(candidates).toContain('concepts/Quux.md');
  });

  it('builds graph edges through alias wikilinks', async () => {
    const idx = await getIndex();
    // Other.md → Bar (alias of Foo) should produce an edge from Other to Foo,
    // matching the same shape as a direct [[Foo]] link. Both wikilinks in
    // Other.md target the same note, so count is 2.
    const edge = idx.edges.find(
      (e) => e.from === 'products/Other.md' && e.to === 'concepts/Foo.md',
    );
    expect(edge).toBeDefined();
    expect(edge?.count).toBe(2);
  });

  it('still indexes filename basenames alongside aliases', async () => {
    const idx = await getIndex();
    expect(idx.titles.get('foo')).toContain('concepts/Foo.md');
    expect(idx.titles.get('other')).toContain('products/Other.md');
  });
});
