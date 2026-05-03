import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { getGraph, topNotesByImportance, invalidatePageRank } from '../graph';
import { invalidateIndex } from '../vault-index';

let tmpRoot: string;
let originalEnv: string | undefined;

beforeAll(async () => {
  tmpRoot = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), 'codex-graph-')),
  );

  // 3 folders, hub-and-spoke topology so PageRank has clear winners.
  await fs.mkdir(path.join(tmpRoot, '20 - Products'), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, '30 - Architecture'), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, '40 - Concepts'), { recursive: true });

  // Hub note in Architecture, linked TO by many.
  await fs.writeFile(
    path.join(tmpRoot, '30 - Architecture', 'Auth.md'),
    `---
tags: [architecture]
---
# Auth
Central auth doc.`,
  );

  // Spokes link to Auth.
  await fs.writeFile(
    path.join(tmpRoot, '20 - Products', 'NexaDeck.md'),
    `---
tags: [product]
---
# NexaDeck
Talks to [[Auth]].`,
  );
  await fs.writeFile(
    path.join(tmpRoot, '20 - Products', 'NexaLive.md'),
    `---
tags: [product]
---
# NexaLive
Also uses [[Auth]] and [[NexaDeck]].`,
  );
  await fs.writeFile(
    path.join(tmpRoot, '40 - Concepts', 'Tokens.md'),
    `---
tags: [concept]
---
# Tokens
Builds on [[Auth]].`,
  );

  originalEnv = process.env.ABYDOS_VAULT_PATH;
  process.env.ABYDOS_VAULT_PATH = tmpRoot;
});

beforeEach(() => {
  invalidateIndex();
  invalidatePageRank();
});

afterAll(async () => {
  if (originalEnv === undefined) {
    delete process.env.ABYDOS_VAULT_PATH;
  } else {
    process.env.ABYDOS_VAULT_PATH = originalEnv;
  }
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('getGraph (supernode)', () => {
  it('returns one node per top-level folder with note counts', async () => {
    const g = await getGraph(null);
    expect(g.scope).toBeNull();
    const folderIds = g.nodes.map((n) => n.id).sort();
    expect(folderIds).toEqual(['20 - Products', '30 - Architecture', '40 - Concepts']);
    for (const node of g.nodes) {
      expect(node.kind).toBe('SUPERNODE');
      expect(node.noteCount).toBeGreaterThan(0);
    }
  });

  it('builds inter-folder edges with cumulative weight', async () => {
    const g = await getGraph(null);
    const productsToArch = g.edges.find(
      (e) => e.from === '20 - Products' && e.to === '30 - Architecture',
    );
    // NexaDeck -> Auth (1) + NexaLive -> Auth (1) = 2
    expect(productsToArch?.weight).toBe(2);
    // No self-edges.
    for (const edge of g.edges) {
      expect(edge.from).not.toBe(edge.to);
    }
  });
});

describe('getGraph (folder subgraph)', () => {
  it('returns notes within scope and only intra-scope edges', async () => {
    const g = await getGraph('20 - Products');
    expect(g.scope).toBe('20 - Products');
    const ids = g.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['20 - Products/NexaDeck.md', '20 - Products/NexaLive.md']);
    for (const edge of g.edges) {
      expect(ids).toContain(edge.from);
      expect(ids).toContain(edge.to);
    }
    // NexaLive -> NexaDeck is in-scope.
    expect(
      g.edges.some(
        (e) =>
          e.from === '20 - Products/NexaLive.md' &&
          e.to === '20 - Products/NexaDeck.md',
      ),
    ).toBe(true);
  });

  it('attaches PageRank scores to note nodes', async () => {
    const g = await getGraph('20 - Products');
    for (const node of g.nodes) {
      expect(node.kind).toBe('NOTE');
      expect(node.pageRank).toBeGreaterThan(0);
    }
  });
});

describe('topNotesByImportance', () => {
  it('ranks the hub note above its spokes', async () => {
    const top = await topNotesByImportance(10);
    expect(top.length).toBeGreaterThan(0);
    expect(top[0].path).toBe('30 - Architecture/Auth.md');
  });
});
