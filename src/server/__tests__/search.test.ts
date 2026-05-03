import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { searchVault } from '../search';
import { invalidateIndex } from '../vault-index';

let tmpRoot: string;
let originalEnv: string | undefined;

beforeAll(async () => {
  tmpRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'codex-search-')),
  );
  await fs.mkdir(path.join(tmpRoot, '20 - Products'), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, '40 - Concepts'), { recursive: true });

  await fs.writeFile(
    path.join(tmpRoot, '20 - Products', 'NexaDeck.md'),
    `---
tags: [product, karaoke]
status: active
---
# NexaDeck
Desktop karaoke deck.`,
  );
  await fs.writeFile(
    path.join(tmpRoot, '20 - Products', 'NexaLive.md'),
    `---
tags: [product, web]
status: active
---
# NexaLive
Web platform.`,
  );
  await fs.writeFile(
    path.join(tmpRoot, '40 - Concepts', 'Karaoke.md'),
    `---
tags: [concept, audio]
---
# Karaoke
Domain concept.`,
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

describe('searchVault', () => {
  it('returns exact title match first', async () => {
    const hits = await searchVault('NexaDeck');
    expect(hits[0].meta.title).toBe('NexaDeck');
    expect(hits[0].matchedOn).toBe('title');
  });

  it('returns substring matches', async () => {
    const hits = await searchVault('nexa');
    const titles = hits.map((h) => h.meta.title).sort();
    expect(titles).toEqual(['NexaDeck', 'NexaLive']);
  });

  it('finds notes by tag', async () => {
    const hits = await searchVault('karaoke');
    const titles = hits.map((h) => h.meta.title);
    // Karaoke title matches first; NexaDeck has 'karaoke' as a tag.
    expect(titles).toContain('Karaoke');
    expect(titles).toContain('NexaDeck');
  });

  it('returns empty array for empty query', async () => {
    expect(await searchVault('')).toEqual([]);
    expect(await searchVault('   ')).toEqual([]);
  });

  it('returns empty array for no matches', async () => {
    expect(await searchVault('zzznotfound')).toEqual([]);
  });

  it('respects limit', async () => {
    const hits = await searchVault('nexa', 1);
    expect(hits.length).toBe(1);
  });
});
