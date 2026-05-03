// In-process vault index for AbydosCodex.
// Lazy-built singleton. Walks the vault root, parses every .md file once,
// caches { files, titles, edges } in memory.
//
// Invalidation is currently coarse: invalidateIndex() drops the cache and the
// next read rebuilds. The cron-pull route invalidates after a successful
// `git pull`. PR 3 will add finer-grained mtime-based incremental refresh.

import path from 'node:path';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { getVaultRoot } from './config';
import { parseNote } from './frontmatter';
import { extractWikilinks, resolveWikilink, type Wikilink } from './wikilinks';
import { isAutoManagedPath } from './auto-managed';

/** SHA-256 of the raw file bytes, used as an opaque optimistic-concurrency token. */
export function contentSha(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

export interface NoteMeta {
  path: string;
  title: string;
  folder: string;
  status?: string;
  tags: string[];
  mtime: number;
  size: number;
  outboundLinks: Wikilink[];
  isAutoManaged: boolean;
  /** SHA-256 of the file content at index time — used for optimistic concurrency on save. */
  sha: string;
  /** Plain-text body content (post-frontmatter), kept in-index for body search. */
  body: string;
}

export interface Edge {
  from: string;
  to: string;
  count: number;
}

export interface VaultIndex {
  files: Map<string, NoteMeta>;
  titles: Map<string, string[]>;
  edges: Edge[];
  builtAt: number;
}

export interface TreeNode {
  name: string;
  path: string;
  kind: 'FOLDER' | 'NOTE';
  status?: string;
  isAutoManaged?: boolean;
  children?: TreeNode[];
}

let cached: VaultIndex | null = null;
let inflight: Promise<VaultIndex> | null = null;

export async function getIndex(): Promise<VaultIndex> {
  if (cached) return cached;
  if (inflight) return inflight;
  inflight = buildIndex().finally(() => {
    inflight = null;
  });
  cached = await inflight;
  return cached;
}

export function invalidateIndex(): void {
  cached = null;
}

async function buildIndex(): Promise<VaultIndex> {
  const files = new Map<string, NoteMeta>();
  const titles = new Map<string, string[]>();
  await walk(getVaultRoot(), '', files, titles);

  const edges: Edge[] = [];
  for (const [, meta] of files) {
    const linkCounts = new Map<string, number>();
    for (const link of meta.outboundLinks) {
      if (link.isEmbed) continue; // attachment embeds aren't graph edges
      const resolved = resolveWikilink(link.target, titles);
      if (resolved && resolved !== meta.path) {
        linkCounts.set(resolved, (linkCounts.get(resolved) ?? 0) + 1);
      }
    }
    for (const [to, count] of linkCounts) {
      edges.push({ from: meta.path, to, count });
    }
  }

  return { files, titles, edges, builtAt: Date.now() };
}

async function walk(
  root: string,
  rel: string,
  files: Map<string, NoteMeta>,
  titles: Map<string, string[]>,
): Promise<void> {
  const abs = rel ? path.join(root, rel) : root;
  let entries: Dirent[];
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === '.obsidian') continue;
    if (entry.name === 'node_modules') continue;
    if (entry.name.startsWith('.')) continue;
    const childRel = rel ? path.join(rel, entry.name) : entry.name;
    if (entry.isDirectory()) {
      await walk(root, childRel, files, titles);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      const childAbs = path.join(root, childRel);
      try {
        const [stat, raw] = await Promise.all([
          fs.stat(childAbs),
          fs.readFile(childAbs, 'utf8'),
        ]);
        const parsed = parseNote(raw);
        const folder = childRel.split(path.sep)[0];
        const title = entry.name.replace(/\.md$/i, '');
        const meta: NoteMeta = {
          path: childRel,
          title,
          folder,
          status: parsed.data.status,
          tags: parsed.data.tags ?? [],
          mtime: stat.mtimeMs,
          size: stat.size,
          outboundLinks: extractWikilinks(parsed.content),
          isAutoManaged: isAutoManagedPath(childRel),
          sha: contentSha(raw),
          body: parsed.content,
        };
        files.set(childRel, meta);
        const lower = title.toLowerCase();
        const arr = titles.get(lower) ?? [];
        arr.push(childRel);
        titles.set(lower, arr);
      } catch {
        // Skip unreadable files; surfaces on next rebuild.
      }
    }
  }
}

export async function getTree(): Promise<TreeNode> {
  const idx = await getIndex();
  const root: TreeNode = { name: '', path: '', kind: 'FOLDER', children: [] };
  const sorted = [...idx.files.entries()].sort(([a], [b]) => a.localeCompare(b));
  for (const [rel, meta] of sorted) {
    const parts = rel.split(path.sep);
    let cursor = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const segPath = parts.slice(0, i + 1).join(path.sep);
      let next = cursor.children!.find(
        (c) => c.kind === 'FOLDER' && c.name === parts[i],
      );
      if (!next) {
        next = { name: parts[i], path: segPath, kind: 'FOLDER', children: [] };
        cursor.children!.push(next);
      }
      cursor = next;
    }
    cursor.children!.push({
      name: meta.title,
      path: rel,
      kind: 'NOTE',
      status: meta.status,
      isAutoManaged: meta.isAutoManaged,
    });
  }
  return root;
}

export async function getNoteMeta(rel: string): Promise<NoteMeta | null> {
  const idx = await getIndex();
  return idx.files.get(rel) ?? null;
}
