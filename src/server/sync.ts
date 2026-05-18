// Sync coordinator for vault edits.
//
// Goals:
//   1. Serialize all writes — only one save proceeds at a time, so we never
//      race git or interleave commits within the same request lifecycle.
//   2. Optimistic concurrency — the caller passes the baseSha they read from;
//      if the on-disk file changed since, return a CONFLICT result with the
//      current content instead of overwriting.
//   3. Secret guard — refuse content matching scan rules.
//   4. Auto-managed guard — refuse writes to nightly-journal-managed paths.
//   5. Pull-before-push — debounced push happens *after* the request returns.
//   6. Index invalidation on every successful change.
//
// Out of scope for this PR: 3-way merge, conflict resolution UI on the server.
// We surface conflicts to the client and let the user resolve manually.

import path from 'node:path';
import fs from 'node:fs/promises';
import {
  writeVaultFile,
  readVaultFile,
  vaultFileExists,
  resolveVaultPath,
  writeVaultBinary,
} from './fs';
import { contentSha, invalidateIndex, getIndex } from './vault-index';
import { invalidatePageRank } from './graph';
import { isAutoManagedPath } from './auto-managed';
import { scanContent, type SecretHit } from './secrets';
import {
  commitFiles,
  pullRebase,
  push,
  readFileAtSha,
  getFileHistory,
  type CommitHistoryEntry,
} from './git';
import { rewriteWikilinks, type Wikilink } from './wikilinks';
import {
  getAttachmentsDir,
  getMaxUploadBytes,
  getAllowedAttachmentExts,
} from './config';
import { parseNote, serializeNote, type Frontmatter } from './frontmatter';
import { generateUuidV7, isValidUuid } from './uuid';

/**
 * Ensure the content carries a frontmatter `uuid:` field. If absent, inject
 * a fresh v7 UUID and re-serialize. Idempotent — content that already has
 * a valid UUID round-trips unchanged.
 *
 * Used by saveNote and friends so every committed note carries a stable
 * identifier from its first write. Anchors comments, annotations,
 * embeddings, audit-log entries.
 */
function ensureNoteUuid(content: string): string {
  const parsed = parseNote(content);
  if (isValidUuid(parsed.data.uuid)) return content;
  parsed.data.uuid = generateUuidV7();
  return serializeNote(parsed.data, parsed.content);
}

export type SaveOutcome =
  | { kind: 'OK'; newSha: string; commitSha: string }
  | { kind: 'CONFLICT'; currentContent: string; currentSha: string }
  | { kind: 'SECRETS'; hits: SecretHit[] }
  | { kind: 'AUTO_MANAGED'; reason: string }
  | { kind: 'NOOP'; sha: string };

export interface SaveOptions {
  /** Vault-relative path, e.g. `20 - Products/NexaDeck.md`. */
  path: string;
  /** Full new file content (frontmatter + body). */
  content: string;
  /**
   * SHA the caller observed when reading the note. If the on-disk SHA no
   * longer matches, we return CONFLICT with the current state.
   * Pass null when creating a new file.
   */
  baseSha: string | null;
  /** Author for the commit. Comes from the authenticated session. */
  author: { name: string; email: string };
  /** Commit message — caller supplies (e.g. "Edit NexaDeck.md via admin panel"). */
  commitMessage: string;
}

// Single mutex for all vault writes. Implemented as a promise chain.
let mutex: Promise<unknown> = Promise.resolve();

function lock<T>(fn: () => Promise<T>): Promise<T> {
  const next = mutex.then(fn, fn);
  // Swallow rejections in the chain so one failure doesn't block subsequent
  // saves — but each caller still sees its own error.
  mutex = next.catch(() => undefined);
  return next;
}

let pushTimer: NodeJS.Timeout | null = null;
const PUSH_DEBOUNCE_MS = 5000;

function schedulePush(): void {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    void runPush();
  }, PUSH_DEBOUNCE_MS);
}

async function runPush(): Promise<void> {
  try {
    await lock(async () => {
      await push();
    });
  } catch (err) {
    console.error('[codex-sync] push failed:', err);
  }
}

/**
 * Save (or create) a note with optimistic-concurrency check, secret scan,
 * auto-managed guard, atomic write + commit, and debounced push.
 *
 * The whole sequence runs under the write mutex so concurrent saves don't
 * stomp each other.
 */
export async function saveNote(opts: SaveOptions): Promise<SaveOutcome> {
  return lock(async () => {
    if (isAutoManagedPath(opts.path)) {
      return { kind: 'AUTO_MANAGED', reason: 'This file is managed by the nightly-journal automation. Edit safe sections only.' };
    }

    // Inject a stable v7 UUID into the frontmatter if missing. Idempotent
    // on subsequent saves — content that already has a valid uuid round-
    // trips unchanged. Done before the secret scan + no-op check so the
    // value we scan + write + hash is the final on-disk form.
    const finalContent = ensureNoteUuid(opts.content);

    const hits = scanContent(finalContent);
    if (hits.length > 0) {
      return { kind: 'SECRETS', hits };
    }

    const exists = await vaultFileExists(opts.path);
    if (exists) {
      const current = await readVaultFile(opts.path);
      const currentSha = contentSha(current);

      if (opts.baseSha === null) {
        // Caller thought they were creating a new file but it exists.
        return { kind: 'CONFLICT', currentContent: current, currentSha };
      }
      if (opts.baseSha !== currentSha) {
        return { kind: 'CONFLICT', currentContent: current, currentSha };
      }
      // Unchanged content → no-op so we don't make an empty commit.
      if (current === finalContent) {
        return { kind: 'NOOP', sha: currentSha };
      }
    } else if (opts.baseSha !== null) {
      // Caller thought the file existed but it doesn't.
      return { kind: 'CONFLICT', currentContent: '', currentSha: '' };
    }

    // Pull before write so we rebase on top of any incoming changes.
    try {
      await pullRebase();
    } catch (err) {
      console.warn('[codex-sync] pre-write pull failed; proceeding with local write:', err);
    }

    await writeVaultFile(opts.path, finalContent);

    const newSha = contentSha(finalContent);
    const commit = await commitFiles([opts.path], opts.commitMessage, opts.author);

    invalidateIndex();
    invalidatePageRank();
    schedulePush();

    return { kind: 'OK', newSha, commitSha: commit.sha };
  });
}

// ─── UUID backfill ────────────────────────────────────────────────────────

export type BackfillUuidsOutcome =
  | {
      kind: 'OK';
      commitSha: string | null;
      /** Vault-relative paths that received a UUID in this run. */
      updatedFiles: string[];
      /** Notes that already had a UUID. */
      skipped: number;
    }
  | { kind: 'NOOP'; reason: string }
  | { kind: 'INVALID'; reason: string };

export interface BackfillUuidsOptions {
  author: { name: string; email: string };
  commitMessage?: string;
  /** Optional dry-run — produce the list of files that WOULD be updated
   *  without writing or committing anything. */
  dryRun?: boolean;
}

/**
 * One-shot backfill: walks every .md note in the vault, finds the ones
 * without a frontmatter `uuid:` field, injects a fresh v7 UUID into
 * each, and commits all updates in a single batch.
 *
 * Idempotent — re-running after a successful backfill is a NOOP.
 * Auto-managed paths are skipped (the nightly-journal automation owns
 * those; they can opt in to UUIDs separately if/when needed).
 *
 * Designed to be invoked once per existing vault. New notes saved
 * through `saveNote` get a UUID automatically on first write.
 */
export async function backfillNoteUuids(
  opts: BackfillUuidsOptions,
): Promise<BackfillUuidsOutcome> {
  return lock(async () => {
    const idx = await getIndex();
    const candidates: Array<{ rel: string; newContent: string }> = [];
    let skipped = 0;

    for (const [rel, meta] of idx.files) {
      if (meta.isAutoManaged) continue;
      if (meta.uuid) {
        skipped++;
        continue;
      }
      // Re-read from disk (index has body sans frontmatter; we need raw).
      const raw = await readVaultFile(rel);
      const parsed = parseNote(raw);
      if (isValidUuid(parsed.data.uuid)) {
        // Index was stale; nothing to do.
        skipped++;
        continue;
      }
      parsed.data.uuid = generateUuidV7();
      const newContent = serializeNote(parsed.data, parsed.content);
      candidates.push({ rel, newContent });
    }

    if (candidates.length === 0) {
      return { kind: 'NOOP', reason: 'every note already has a uuid' };
    }

    if (opts.dryRun) {
      return {
        kind: 'OK',
        commitSha: null,
        updatedFiles: candidates.map((c) => c.rel),
        skipped,
      };
    }

    try {
      await pullRebase();
    } catch (err) {
      console.warn('[codex-sync] pre-backfill pull failed; proceeding:', err);
    }

    for (const { rel, newContent } of candidates) {
      await writeVaultFile(rel, newContent);
    }

    const paths = candidates.map((c) => c.rel);
    const message =
      opts.commitMessage?.trim() ||
      `Backfill frontmatter UUIDs across ${paths.length} note${paths.length === 1 ? '' : 's'}`;
    const commit = await commitFiles(paths, message, opts.author);

    invalidateIndex();
    invalidatePageRank();
    schedulePush();

    return {
      kind: 'OK',
      commitSha: commit.sha,
      updatedFiles: paths,
      skipped,
    };
  });
}

// ─── Rename (chriscase/abydonian#213) ──────────────────────────────────────

export type RenameOutcome =
  | {
      kind: 'OK';
      newPath: string;
      commitSha: string;
      /** Vault-relative paths whose wikilinks were updated by this rename. */
      rewrittenFiles: string[];
    }
  | { kind: 'NOT_FOUND'; reason: string }
  | { kind: 'CONFLICT'; reason: string }
  | { kind: 'AUTO_MANAGED'; reason: string }
  | { kind: 'INVALID'; reason: string };

export interface RenameOptions {
  oldPath: string;
  newPath: string;
  author: { name: string; email: string };
  commitMessage: string;
}

function normalizedFormsOfPath(p: string): {
  full: string;
  noExt: string;
  baseFull: string;
  base: string;
} {
  const noExt = p.replace(/\.md$/i, '');
  const slash = noExt.lastIndexOf('/');
  const base = slash >= 0 ? noExt.slice(slash + 1) : noExt;
  return {
    full: p,
    noExt,
    baseFull: base + '.md',
    base,
  };
}

function anyLinkPointsTo(links: Wikilink[], oldPath: string): boolean {
  const f = normalizedFormsOfPath(oldPath);
  const fullLc = f.full.toLowerCase();
  const noExtLc = f.noExt.toLowerCase();
  const baseFullLc = f.baseFull.toLowerCase();
  const baseLc = f.base.toLowerCase();
  for (const link of links) {
    const t = link.target.trim().toLowerCase();
    if (t === fullLc || t === noExtLc || t === baseFullLc || t === baseLc) {
      return true;
    }
  }
  return false;
}

/**
 * Rename a vault note, walking the entire vault to rewrite every inbound
 * wikilink so backlinks survive the rename. The rename + every rewrite are
 * staged together and committed in a single atomic git commit.
 *
 * Refuses if:
 *   - either path isn't a `.md` file
 *   - either path is auto-managed (70 - Journals/, 80 - Daily/)
 *   - source doesn't exist
 *   - destination already exists
 *   - paths are identical
 *
 * Path-traversal guarded by `resolveVaultPath()` (throws PathTraversalError).
 */
export async function renameNote(opts: RenameOptions): Promise<RenameOutcome> {
  return lock(async () => {
    const { oldPath, newPath } = opts;

    if (!oldPath.endsWith('.md') || !newPath.endsWith('.md')) {
      return { kind: 'INVALID', reason: 'Rename only supports .md notes.' };
    }
    if (oldPath === newPath) {
      return { kind: 'INVALID', reason: 'Old and new paths are identical.' };
    }
    if (isAutoManagedPath(oldPath)) {
      return {
        kind: 'AUTO_MANAGED',
        reason:
          'Source note is managed by the nightly journal automation and cannot be renamed.',
      };
    }
    if (isAutoManagedPath(newPath)) {
      return {
        kind: 'AUTO_MANAGED',
        reason:
          'Destination is in an auto-managed area (70 - Journals/ or 80 - Daily/). Choose a different folder.',
      };
    }
    if (!(await vaultFileExists(oldPath))) {
      return { kind: 'NOT_FOUND', reason: `No note at '${oldPath}'.` };
    }
    if (await vaultFileExists(newPath)) {
      return { kind: 'CONFLICT', reason: `A note already exists at '${newPath}'.` };
    }

    // Pre-validate path traversal for both paths (throws if outside vault).
    const oldAbs = resolveVaultPath(oldPath);
    const newAbs = resolveVaultPath(newPath);

    // Pull-rebase to absorb any concurrent remote changes. Soft-fail: if the
    // pull errors (no remote, network issue) we proceed; the push later may
    // race, but that's the same behavior as saveNote.
    try {
      await pullRebase();
    } catch (err) {
      console.warn('[codex-sync] pre-rename pull failed; proceeding:', err);
    }

    // Walk the (in-memory) index to find every note that links to oldPath
    // and pre-compute the rewritten content. Done BEFORE the rename so the
    // index is still keyed on oldPath.
    const idx = await getIndex();
    const rewrites: Array<{ path: string; content: string }> = [];
    for (const [notePath, meta] of idx.files) {
      if (notePath === oldPath) continue;
      if (!anyLinkPointsTo(meta.outboundLinks, oldPath)) continue;
      const current = await readVaultFile(notePath);
      const rewritten = rewriteWikilinks(current, oldPath, newPath);
      if (rewritten.replacements > 0) {
        rewrites.push({ path: notePath, content: rewritten.content });
      }
    }

    // Do the move on disk (creating the destination directory if needed).
    await fs.mkdir(path.dirname(newAbs), { recursive: true });
    await fs.rename(oldAbs, newAbs);

    // Apply self-referential rewrites in the renamed file too (rare —
    // notes that link to themselves via the renamed name).
    const renamedContent = await readVaultFile(newPath);
    const selfRewritten = rewriteWikilinks(renamedContent, oldPath, newPath);
    if (selfRewritten.replacements > 0) {
      await writeVaultFile(newPath, selfRewritten.content);
    }

    // Write all the inbound-link rewrites.
    for (const r of rewrites) {
      await writeVaultFile(r.path, r.content);
    }

    // Commit: stage the deletion of oldPath, the addition of newPath, and
    // every rewritten note in one atomic commit. `git add` on a deleted
    // path stages the deletion; on a new path, stages the creation; git
    // detects the rename at commit time. commitFiles' "no changes" guard
    // passes because newPath shows up as `created` in git status.
    const allPaths = [oldPath, newPath, ...rewrites.map((r) => r.path)];
    const commit = await commitFiles(allPaths, opts.commitMessage, opts.author);

    invalidateIndex();
    invalidatePageRank();
    schedulePush();

    return {
      kind: 'OK',
      newPath,
      commitSha: commit.sha,
      rewrittenFiles: rewrites.map((r) => r.path),
    };
  });
}

// ─── Delete (chriscase/abydonian#214) ──────────────────────────────────────

export type DeleteOutcome =
  | { kind: 'OK'; commitSha: string; orphanedFiles: string[] }
  | { kind: 'NOT_FOUND'; reason: string }
  | { kind: 'AUTO_MANAGED'; reason: string }
  | { kind: 'INVALID'; reason: string };

export interface DeleteOptions {
  path: string;
  author: { name: string; email: string };
  commitMessage: string;
}

/**
 * Delete a vault note. Walks the index to identify files whose wikilinks
 * will become orphans (returned in the result so the UI can surface them
 * post-delete) and commits the deletion atomically.
 *
 * Refuses if:
 *   - path isn't a `.md` file
 *   - path is auto-managed (70 - Journals/, 80 - Daily/)
 *   - file doesn't exist
 *
 * Note: this does NOT rewrite or remove orphan wikilinks in other notes —
 * that would be too invasive. The caller (UI) shows a confirmation modal
 * listing inbound links so the user knows what they're orphaning.
 */
export async function deleteNote(opts: DeleteOptions): Promise<DeleteOutcome> {
  return lock(async () => {
    const { path: rel } = opts;

    if (!rel.endsWith('.md')) {
      return { kind: 'INVALID', reason: 'Delete only supports .md notes.' };
    }
    if (isAutoManagedPath(rel)) {
      return {
        kind: 'AUTO_MANAGED',
        reason:
          'This note is managed by the nightly journal automation and cannot be deleted from the admin panel.',
      };
    }
    if (!(await vaultFileExists(rel))) {
      return { kind: 'NOT_FOUND', reason: `No note at '${rel}'.` };
    }

    // Pre-validate path traversal.
    const abs = resolveVaultPath(rel);

    // Find all inbound links so we can report which notes are now orphaned
    // (wikilinks that resolve to nothing). Use the in-memory index BEFORE
    // the delete so the link table is still keyed correctly.
    const idx = await getIndex();
    const orphanedFiles: string[] = [];
    for (const [notePath, meta] of idx.files) {
      if (notePath === rel) continue;
      if (anyLinkPointsTo(meta.outboundLinks, rel)) {
        orphanedFiles.push(notePath);
      }
    }

    // Pull-rebase to absorb any concurrent remote changes.
    try {
      await pullRebase();
    } catch (err) {
      console.warn('[codex-sync] pre-delete pull failed; proceeding:', err);
    }

    // fs.unlink + git add stages the deletion. commitFiles does the add.
    await fs.unlink(abs);

    const commit = await commitFiles([rel], opts.commitMessage, opts.author);

    invalidateIndex();
    invalidatePageRank();
    schedulePush();

    return {
      kind: 'OK',
      commitSha: commit.sha,
      orphanedFiles,
    };
  });
}

// ─── Create folder (chriscase/abydonian#215) ────────────────────────────────

export type CreateFolderOutcome =
  | { kind: 'OK'; path: string; commitSha: string }
  | { kind: 'CONFLICT'; reason: string }
  | { kind: 'AUTO_MANAGED'; reason: string }
  | { kind: 'INVALID'; reason: string };

export interface CreateFolderOptions {
  path: string;
  author: { name: string; email: string };
  commitMessage: string;
}

const FOLDER_PATH_RE = /^[A-Za-z0-9 _\-().,&/]+$/;

/**
 * Create a new folder in the vault. Git doesn't track empty directories, so
 * we mkdir the folder AND drop a `.gitkeep` file inside, committing only the
 * `.gitkeep` (which records the folder's existence in git).
 *
 * Refuses if:
 *   - path contains invalid characters
 *   - path is auto-managed (under 70 - Journals/ or 80 - Daily/, where folder
 *     structure is created by the nightly script — admin-created folders here
 *     would conflict)
 *   - folder already exists
 *
 * Path-traversal guarded by `resolveVaultPath()` (throws PathTraversalError).
 */
export async function createFolder(opts: CreateFolderOptions): Promise<CreateFolderOutcome> {
  return lock(async () => {
    let normalized = opts.path.trim();
    // Strip any trailing slash so the rest of the logic can assume a clean
    // folder path (`mkdir -p` accepts both, but our auto-managed check below
    // wants a deterministic shape).
    while (normalized.endsWith('/')) {
      normalized = normalized.slice(0, -1);
    }

    if (!normalized) {
      return { kind: 'INVALID', reason: 'Folder path is required.' };
    }
    if (!FOLDER_PATH_RE.test(normalized)) {
      return {
        kind: 'INVALID',
        reason:
          'Use letters, numbers, spaces, slashes, and basic punctuation (- _ . , & ( )).',
      };
    }
    if (isAutoManagedPath(normalized + '/x.md')) {
      return {
        kind: 'AUTO_MANAGED',
        reason:
          'Cannot create folders under 70 - Journals/ or 80 - Daily/ (those are managed by the nightly journal automation).',
      };
    }

    // resolveVaultPath rejects null bytes, absolute paths, and any rel
    // that escapes the vault root. We compute the absolute paths via the
    // gitkeep path inside the proposed folder so we get the path-traversal
    // guarantees for free.
    const gitkeepRel = normalized + '/.gitkeep';
    const gitkeepAbs = resolveVaultPath(gitkeepRel);
    const folderAbs = path.dirname(gitkeepAbs);

    try {
      const stat = await fs.stat(folderAbs);
      if (stat.isDirectory()) {
        return { kind: 'CONFLICT', reason: `Folder '${normalized}' already exists.` };
      }
      return { kind: 'CONFLICT', reason: `Path '${normalized}' exists and is not a folder.` };
    } catch {
      // Folder doesn't exist — what we want.
    }

    // Pull-rebase to absorb any concurrent remote changes.
    try {
      await pullRebase();
    } catch (err) {
      console.warn('[codex-sync] pre-create-folder pull failed; proceeding:', err);
    }

    await fs.mkdir(folderAbs, { recursive: true });
    // .gitkeep is a convention; the file is empty, just there so git tracks
    // the directory. (Per AbydosCodex convention we use a leading dot so the
    // file is hidden in Obsidian's tree view; vault-index also skips dotfiles.)
    await fs.writeFile(gitkeepAbs, '', 'utf8');

    const commit = await commitFiles([gitkeepRel], opts.commitMessage, opts.author);

    invalidateIndex();
    invalidatePageRank();
    schedulePush();

    return {
      kind: 'OK',
      path: normalized,
      commitSha: commit.sha,
    };
  });
}

// ─── Rename folder (chriscase/abydonian#216) ────────────────────────────────

export type RenameFolderOutcome =
  | {
      kind: 'OK';
      newPath: string;
      commitSha: string;
      renamedNotes: number;
      rewrittenFiles: string[];
    }
  | { kind: 'NOT_FOUND'; reason: string }
  | { kind: 'CONFLICT'; reason: string }
  | { kind: 'AUTO_MANAGED'; reason: string }
  | { kind: 'INVALID'; reason: string };

export interface RenameFolderOptions {
  oldPath: string;
  newPath: string;
  author: { name: string; email: string };
  commitMessage: string;
}

function normalizeFolderPath(p: string): string {
  let out = p.trim();
  while (out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/**
 * Rename or move a folder. Recursively renames every note inside, rewrites
 * every inbound wikilink to any of those notes (both inside and outside the
 * renamed folder), and commits the whole thing atomically.
 */
export async function renameFolder(opts: RenameFolderOptions): Promise<RenameFolderOutcome> {
  return lock(async () => {
    const oldPath = normalizeFolderPath(opts.oldPath);
    const newPath = normalizeFolderPath(opts.newPath);

    if (!oldPath || !newPath) {
      return { kind: 'INVALID', reason: 'Folder paths cannot be empty.' };
    }
    if (oldPath === newPath) {
      return { kind: 'INVALID', reason: 'Old and new folder paths are identical.' };
    }
    if (!FOLDER_PATH_RE.test(oldPath) || !FOLDER_PATH_RE.test(newPath)) {
      return {
        kind: 'INVALID',
        reason:
          'Use letters, numbers, spaces, slashes, and basic punctuation (- _ . , & ( )).',
      };
    }
    if (isAutoManagedPath(oldPath + '/x.md')) {
      return {
        kind: 'AUTO_MANAGED',
        reason: 'Source folder is under 70 - Journals/ or 80 - Daily/; cannot rename.',
      };
    }
    if (isAutoManagedPath(newPath + '/x.md')) {
      return {
        kind: 'AUTO_MANAGED',
        reason: 'Destination is under 70 - Journals/ or 80 - Daily/; choose elsewhere.',
      };
    }
    if (newPath === oldPath || newPath.startsWith(oldPath + '/')) {
      return {
        kind: 'INVALID',
        reason: 'Cannot move a folder into itself or a descendant.',
      };
    }

    // Path-traversal-guarded absolute paths via probe gitkeeps.
    const oldProbe = resolveVaultPath(oldPath + '/.gitkeep');
    const newProbe = resolveVaultPath(newPath + '/.gitkeep');
    const oldAbs = path.dirname(oldProbe);
    const newAbs = path.dirname(newProbe);

    try {
      const stat = await fs.stat(oldAbs);
      if (!stat.isDirectory()) {
        return { kind: 'NOT_FOUND', reason: `Path '${oldPath}' is not a folder.` };
      }
    } catch {
      return { kind: 'NOT_FOUND', reason: `Folder '${oldPath}' does not exist.` };
    }
    try {
      await fs.stat(newAbs);
      return { kind: 'CONFLICT', reason: `Destination '${newPath}' already exists.` };
    } catch {
      // Good — destination is free.
    }

    try {
      await pullRebase();
    } catch (err) {
      console.warn('[codex-sync] pre-rename-folder pull failed; proceeding:', err);
    }

    // Build the rename map: every .md file under oldPath gets a new path
    // under newPath, preserving the relative structure.
    const idx = await getIndex();
    const renames = new Map<string, string>(); // oldRel → newRel
    for (const [notePath] of idx.files) {
      if (notePath === oldPath || notePath.startsWith(oldPath + '/')) {
        const suffix = notePath.slice(oldPath.length); // includes leading '/'
        renames.set(notePath, newPath + suffix);
      }
    }

    // Walk every note in the index. For each note that links to ANY of the
    // renamed paths, chain the rewrites so the final content reflects every
    // applicable rename. Cache the in-flight content via the rewriteMap so
    // each affected file is rewritten once per (file, rename) pair without
    // round-tripping the disk between iterations.
    const rewriteMap = new Map<string, string>();
    for (const [oldNote, newNote] of renames) {
      for (const [otherPath, otherMeta] of idx.files) {
        if (!anyLinkPointsTo(otherMeta.outboundLinks, oldNote)) continue;
        let current = rewriteMap.get(otherPath);
        if (current === undefined) {
          current = await readVaultFile(otherPath);
        }
        const rewritten = rewriteWikilinks(current, oldNote, newNote);
        if (rewritten.replacements > 0) {
          rewriteMap.set(otherPath, rewritten.content);
        }
      }
    }

    // Atomic rename of the folder on disk.
    await fs.mkdir(path.dirname(newAbs), { recursive: true });
    await fs.rename(oldAbs, newAbs);

    // Apply the rewrites at their NEW paths (folder-internal files moved
    // with the folder; external files keep their original path).
    for (const [affectedOldPath, content] of rewriteMap) {
      const writePath = renames.get(affectedOldPath) ?? affectedOldPath;
      await writeVaultFile(writePath, content);
    }

    // Stage every involved path. The renamed-folder paths show up in
    // `git status` as deleted (oldPath) + created (newPath) — git add on
    // both sides records the rename.
    const allPaths: string[] = [];
    for (const [oldNote, newNote] of renames) {
      allPaths.push(oldNote, newNote);
    }
    for (const [affectedOldPath] of rewriteMap) {
      const writePath = renames.get(affectedOldPath) ?? affectedOldPath;
      if (!allPaths.includes(writePath)) allPaths.push(writePath);
    }

    const commit = await commitFiles(allPaths, opts.commitMessage, opts.author);

    invalidateIndex();
    invalidatePageRank();
    schedulePush();

    const rewrittenFinal = new Set<string>();
    for (const [affectedOldPath] of rewriteMap) {
      rewrittenFinal.add(renames.get(affectedOldPath) ?? affectedOldPath);
    }

    return {
      kind: 'OK',
      newPath,
      commitSha: commit.sha,
      renamedNotes: renames.size,
      rewrittenFiles: [...rewrittenFinal].sort(),
    };
  });
}

// ─── Delete folder (chriscase/abydonian#217) ────────────────────────────────

export type DeleteFolderOutcome =
  | { kind: 'OK'; commitSha: string; deletedFiles: string[]; orphanedFiles: string[] }
  | { kind: 'NOT_FOUND'; reason: string }
  | { kind: 'NOT_EMPTY'; reason: string; fileCount: number }
  | { kind: 'AUTO_MANAGED'; reason: string }
  | { kind: 'INVALID'; reason: string };

export interface DeleteFolderOptions {
  path: string;
  /** When false (default), refuses non-empty folders. Pass true to force
   *  recursive deletion of all .md notes inside. */
  force?: boolean;
  author: { name: string; email: string };
  commitMessage: string;
}

/**
 * Delete a folder from the vault. Refuses non-empty folders unless
 * `force: true` is set. Like deleteNote, does NOT rewrite inbound wikilinks
 * — delete is destructive by design; the caller surfaces the orphan list
 * via the confirmation dialog.
 */
export async function deleteFolder(opts: DeleteFolderOptions): Promise<DeleteFolderOutcome> {
  return lock(async () => {
    const folderPath = normalizeFolderPath(opts.path);

    if (!folderPath) {
      return { kind: 'INVALID', reason: 'Folder path is required.' };
    }
    if (!FOLDER_PATH_RE.test(folderPath)) {
      return { kind: 'INVALID', reason: 'Invalid characters in folder path.' };
    }
    if (isAutoManagedPath(folderPath + '/x.md')) {
      return {
        kind: 'AUTO_MANAGED',
        reason:
          'This folder is under 70 - Journals/ or 80 - Daily/ and cannot be deleted from the admin panel.',
      };
    }

    const probe = resolveVaultPath(folderPath + '/.gitkeep');
    const folderAbs = path.dirname(probe);

    try {
      const stat = await fs.stat(folderAbs);
      if (!stat.isDirectory()) {
        return { kind: 'NOT_FOUND', reason: `Path '${folderPath}' is not a folder.` };
      }
    } catch {
      return { kind: 'NOT_FOUND', reason: `Folder '${folderPath}' does not exist.` };
    }

    // Find every .md file inside the folder via the index.
    const idx = await getIndex();
    const filesInside: string[] = [];
    for (const [notePath] of idx.files) {
      if (notePath === folderPath || notePath.startsWith(folderPath + '/')) {
        filesInside.push(notePath);
      }
    }

    // For the empty check, also account for non-.md files (.gitkeep, future
    // attachments, etc.) — the user shouldn't have to think about which
    // files are tracked vs not.
    const onlyMarkers = await containsOnlyMarkerFiles(folderAbs);

    if (!opts.force && filesInside.length > 0) {
      return {
        kind: 'NOT_EMPTY',
        reason: `Folder '${folderPath}' contains ${filesInside.length} note${filesInside.length === 1 ? '' : 's'}. Re-submit with force=true to delete recursively.`,
        fileCount: filesInside.length,
      };
    }

    // Compute orphan list (notes outside the folder that link in to any
    // file being deleted).
    const orphanedFiles = new Set<string>();
    for (const insidePath of filesInside) {
      for (const [otherPath, otherMeta] of idx.files) {
        if (otherPath === insidePath) continue;
        if (otherPath.startsWith(folderPath + '/')) continue; // also being deleted
        if (anyLinkPointsTo(otherMeta.outboundLinks, insidePath)) {
          orphanedFiles.add(otherPath);
        }
      }
    }

    try {
      await pullRebase();
    } catch (err) {
      console.warn('[codex-sync] pre-delete-folder pull failed; proceeding:', err);
    }

    await fs.rm(folderAbs, { recursive: true, force: true });

    // Stage every deleted .md file. For an empty / marker-only folder, the
    // .gitkeep is the only tracked artifact — stage that.
    const stagePaths: string[] = [...filesInside];
    if (filesInside.length === 0 && onlyMarkers) {
      stagePaths.push(folderPath + '/.gitkeep');
    }
    if (stagePaths.length === 0) {
      // Folder had no tracked files — nothing to commit.
      invalidateIndex();
      invalidatePageRank();
      return {
        kind: 'OK',
        commitSha: '',
        deletedFiles: [],
        orphanedFiles: [...orphanedFiles].sort(),
      };
    }

    const commit = await commitFiles(stagePaths, opts.commitMessage, opts.author);

    invalidateIndex();
    invalidatePageRank();
    schedulePush();

    return {
      kind: 'OK',
      commitSha: commit.sha,
      deletedFiles: filesInside.sort(),
      orphanedFiles: [...orphanedFiles].sort(),
    };
  });
}

async function containsOnlyMarkerFiles(folderAbs: string): Promise<boolean> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(folderAbs, { withFileTypes: true });
  } catch {
    return true;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) return false;
    if (entry.name === '.gitkeep' || entry.name.startsWith('.')) continue;
    return false;
  }
  return true;
}

// ─── Move note / folder (chriscase/abydonian#218) ────────────────────────────

export interface MoveOptions {
  /** Source path — note `.md` or folder. */
  oldPath: string;
  /** Destination parent folder path (the source name is preserved). */
  newParentPath: string;
  author: { name: string; email: string };
  commitMessage: string;
}

/**
 * Move a note into a different folder. Thin wrapper around `renameNote()`
 * that computes the destination path from the parent folder + the source
 * basename.
 */
export async function moveNote(opts: MoveOptions): Promise<RenameOutcome> {
  const sourceName = opts.oldPath.split('/').pop() ?? opts.oldPath;
  const newPath = `${normalizeFolderPath(opts.newParentPath)}/${sourceName}`;
  return renameNote({
    oldPath: opts.oldPath,
    newPath,
    author: opts.author,
    commitMessage: opts.commitMessage,
  });
}

/**
 * Move a folder into a different parent folder. Thin wrapper around
 * `renameFolder()` that computes the destination path.
 */
export async function moveFolder(opts: MoveOptions): Promise<RenameFolderOutcome> {
  const sourceName = normalizeFolderPath(opts.oldPath).split('/').pop() ?? opts.oldPath;
  const newPath = `${normalizeFolderPath(opts.newParentPath)}/${sourceName}`;
  return renameFolder({
    oldPath: opts.oldPath,
    newPath,
    author: opts.author,
    commitMessage: opts.commitMessage,
  });
}

// ─── Attachment upload (chriscase/abydonian#221) ────────────────────────────

export type AttachmentOutcome =
  | {
      kind: 'OK';
      path: string;
      embed: string;
      commitSha: string;
      bytes: number;
    }
  | { kind: 'TOO_LARGE'; reason: string; maxBytes: number }
  | { kind: 'BAD_TYPE'; reason: string; allowed: string[] }
  | { kind: 'INVALID'; reason: string };

export interface AttachmentOptions {
  /** Sanitized filename (no path traversal). Caller validates upstream. */
  filename: string;
  data: Buffer;
  /** When provided, the attachment lives under <attachmentsDir>/<subfolder>/.
   *  Used to scope uploads from a specific note to a sibling folder. */
  subfolder?: string;
  author: { name: string; email: string };
  commitMessage: string;
}

/**
 * Save an uploaded attachment into the vault and commit it. Filename is
 * sanitized (collisions get `-2`, `-3`, etc. suffixes); content is rejected
 * outright when bigger than `getMaxUploadBytes()` or when the extension is
 * not in the allow-list.
 *
 * Returns the vault-relative path the attachment landed at, plus the
 * canonical embed string (`![[...]]`) the editor should insert at the
 * cursor.
 */
export async function uploadAttachment(
  opts: AttachmentOptions,
): Promise<AttachmentOutcome> {
  return lock(async () => {
    const maxBytes = getMaxUploadBytes();
    if (opts.data.length > maxBytes) {
      return {
        kind: 'TOO_LARGE',
        reason: `File is ${opts.data.length} bytes; limit is ${maxBytes}.`,
        maxBytes,
      };
    }

    const safe = sanitizeAttachmentFilename(opts.filename);
    if (!safe) {
      return { kind: 'INVALID', reason: 'Filename is empty after sanitization.' };
    }
    const ext = safe.includes('.')
      ? safe.slice(safe.lastIndexOf('.') + 1).toLowerCase()
      : '';
    const allowed = getAllowedAttachmentExts();
    if (!ext || !allowed.has(ext)) {
      return {
        kind: 'BAD_TYPE',
        reason: `File extension '${ext || '(none)'}' is not allowed.`,
        allowed: [...allowed],
      };
    }

    const dir = getAttachmentsDir();
    const subfolder = opts.subfolder
      ? sanitizeSubfolderPath(opts.subfolder)
      : '';
    const folder = subfolder ? `${dir}/${subfolder}` : dir;

    // Pre-validate path traversal via a probe; throws PathTraversalError if
    // the path escapes the vault root.
    resolveVaultPath(`${folder}/${safe}`);

    // Resolve a unique filename — append `-2`, `-3`, etc. if the base name
    // is already taken. The cap of 1000 attempts is paranoia; a colliding
    // upload at scale would fail loud rather than spin forever.
    const finalRel = await findUniquePath(folder, safe);

    try {
      await pullRebase();
    } catch (err) {
      console.warn('[codex-sync] pre-attachment pull failed; proceeding:', err);
    }

    await writeVaultBinary(finalRel, opts.data);

    const commit = await commitFiles([finalRel], opts.commitMessage, opts.author);

    invalidateIndex();
    invalidatePageRank();
    schedulePush();

    return {
      kind: 'OK',
      path: finalRel,
      embed: buildEmbedFromPath(finalRel),
      commitSha: commit.sha,
      bytes: opts.data.length,
    };
  });
}

/**
 * Build the wikilink-embed form for an attachment path. Matches Obsidian's
 * preference: drop the leading `_attachments/` if present, since the
 * resolver finds attachments by basename anyway. Folder-hinted form is
 * preserved for non-default subfolders.
 */
export function buildEmbedFromPath(rel: string): string {
  const dir = getAttachmentsDir();
  if (rel.startsWith(dir + '/')) {
    const trimmed = rel.slice(dir.length + 1);
    // If the trimmed path still has slashes (subfolders inside _attachments),
    // emit it folder-hinted so the resolver can disambiguate.
    return `![[${trimmed}]]`;
  }
  return `![[${rel}]]`;
}

/**
 * Strip path-traversal sequences and unsafe characters from an upload's
 * filename. Spaces and parens are preserved (vault basenames frequently
 * contain them); everything else outside the alphanumeric + `-_.()` set
 * is replaced with `-`.
 */
export function sanitizeAttachmentFilename(input: string): string {
  // Drop directory components — the caller decides which folder to write to.
  const base = input.replace(/^.*[\\/]/, '').trim();
  if (!base) return '';
  // Strip leading dots so we never write hidden files.
  const cleaned = base.replace(/^\.+/, '');
  // Replace anything outside the allowed set with `-`. Allowing parens +
  // `&` matches the per-note path regex used by the rename mutations so the
  // two stay aligned.
  return cleaned.replace(/[^A-Za-z0-9 _\-().,&]/g, '-');
}

/**
 * Sanitize a vault-relative subfolder path (no traversal, no drive letters,
 * each segment passes the same character allow-list as filenames).
 */
function sanitizeSubfolderPath(input: string): string {
  const segments = input
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter((s) => s && s !== '.' && s !== '..');
  return segments
    .map((s) => s.replace(/[^A-Za-z0-9 _\-().,&]/g, '-'))
    .join('/');
}

async function findUniquePath(folder: string, filename: string): Promise<string> {
  const dot = filename.lastIndexOf('.');
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : '';
  let candidate = `${folder}/${filename}`;
  for (let i = 2; i <= 1000; i++) {
    if (!(await vaultBinaryExists(candidate))) return candidate;
    candidate = `${folder}/${base}-${i}${ext}`;
  }
  throw new Error('Unable to find a unique filename within 1000 attempts');
}

async function vaultBinaryExists(rel: string): Promise<boolean> {
  try {
    const abs = resolveVaultPath(rel);
    const stat = await fs.stat(abs);
    return stat.isFile();
  } catch {
    return false;
  }
}

// ─── Revert (chriscase/abydonian#224) ──────────────────────────────────────

export type RevertOutcome =
  | { kind: 'OK'; commitSha: string; newSha: string }
  | { kind: 'NOT_FOUND'; reason: string }
  | { kind: 'AUTO_MANAGED'; reason: string }
  | { kind: 'NOOP'; reason: string }
  | { kind: 'INVALID'; reason: string };

export interface RevertOptions {
  path: string;
  /** SHA of the commit whose version of `path` we want to restore. */
  sha: string;
  author: { name: string; email: string };
  commitMessage: string;
}

/**
 * Restore a note's content to the version recorded at a specific past
 * commit. Implementation note: this is a content-rollback, NOT a
 * `git revert` — we read the file at `sha`, write it back to disk, and
 * commit normally. Reverting the same commit twice is idempotent; the
 * second attempt returns NOOP.
 */
export async function revertNote(opts: RevertOptions): Promise<RevertOutcome> {
  return lock(async () => {
    const { path: rel, sha } = opts;

    if (!rel.endsWith('.md')) {
      return { kind: 'INVALID', reason: 'Revert only supports .md notes.' };
    }
    if (!sha || sha.length < 4) {
      return { kind: 'INVALID', reason: 'Commit SHA is required.' };
    }
    if (isAutoManagedPath(rel)) {
      return {
        kind: 'AUTO_MANAGED',
        reason: 'Auto-managed notes cannot be reverted from the admin panel.',
      };
    }

    let historicalContent: string;
    try {
      historicalContent = await readFileAtSha(rel, sha);
    } catch (err) {
      return {
        kind: 'NOT_FOUND',
        reason: `File '${rel}' did not exist at commit '${sha}'.`,
      };
    }

    // Secret scan the historical content too — we shouldn't reintroduce
    // secrets even when reverting.
    const hits = scanContent(historicalContent);
    if (hits.length > 0) {
      return {
        kind: 'INVALID',
        reason: `Refused: the historical content contains ${hits.length} secret-like pattern${hits.length === 1 ? '' : 's'}.`,
      };
    }

    if (!(await vaultFileExists(rel))) {
      // The current file doesn't exist — treat this as recreating from
      // history, which is fine.
    } else {
      const current = await readVaultFile(rel);
      if (current === historicalContent) {
        return {
          kind: 'NOOP',
          reason: 'Current content already matches the requested revision.',
        };
      }
    }

    try {
      await pullRebase();
    } catch (err) {
      console.warn('[codex-sync] pre-revert pull failed; proceeding:', err);
    }

    await writeVaultFile(rel, historicalContent);
    const commit = await commitFiles([rel], opts.commitMessage, opts.author);
    const newSha = contentSha(historicalContent);

    invalidateIndex();
    invalidatePageRank();
    schedulePush();

    return { kind: 'OK', commitSha: commit.sha, newSha };
  });
}

/**
 * Convenience re-export so the resolver can fetch a note's history without
 * importing from `git.ts` directly (sync.ts is the public API).
 */
export async function noteHistory(
  rel: string,
  limit?: number,
): Promise<CommitHistoryEntry[]> {
  return getFileHistory(rel, limit);
}

// ─── Find-and-replace (chriscase/abydonian#226) ────────────────────────────

import {
  buildReplacer,
  type ApplyOptions as FindReplaceApplyOptions,
  type ApplyOutcome as FindReplaceApplyOutcome,
} from './find-replace';

/**
 * Apply a previously-previewed find-and-replace across the vault. Walks the
 * index, runs the replacer per-file, writes only files that changed, and
 * commits the whole batch in one git commit.
 *
 * Auto-managed paths are skipped — same as the preview.
 */
export async function applyVaultReplacement(
  opts: FindReplaceApplyOptions,
): Promise<FindReplaceApplyOutcome> {
  return lock(async () => {
    let replacer: ReturnType<typeof buildReplacer>;
    try {
      replacer = buildReplacer(opts);
    } catch (err) {
      return {
        kind: 'INVALID',
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    const idx = await getIndex();
    const writes: Array<{ path: string; content: string; count: number }> = [];

    for (const [path, meta] of idx.files) {
      if (meta.isAutoManaged) continue;
      let current: string;
      try {
        current = await readVaultFile(path);
      } catch {
        continue;
      }
      const { content, count } = replacer(current);
      if (count === 0 || content === current) continue;
      // Re-secret-scan the rewritten content so we never substitute IN a
      // pattern that looks like a credential.
      const hits = scanContent(content);
      if (hits.length > 0) {
        return {
          kind: 'INVALID',
          reason: `Refused: rewriting ${path} would introduce ${hits.length} secret-like pattern${hits.length === 1 ? '' : 's'}.`,
        };
      }
      writes.push({ path, content, count });
    }

    if (writes.length === 0) {
      return { kind: 'NOOP', reason: 'No matches found.' };
    }

    try {
      await pullRebase();
    } catch (err) {
      console.warn('[codex-sync] pre-find-replace pull failed; proceeding:', err);
    }

    for (const w of writes) {
      await writeVaultFile(w.path, w.content);
    }

    const commitMessage =
      opts.commitMessage?.trim() ||
      `Replace "${opts.query}" → "${opts.replacement}" across ${writes.length} file${writes.length === 1 ? '' : 's'}`;
    const commit = await commitFiles(
      writes.map((w) => w.path),
      commitMessage,
      opts.author,
    );

    invalidateIndex();
    invalidatePageRank();
    schedulePush();

    return {
      kind: 'OK',
      commitSha: commit.sha,
      filesChanged: writes.map((w) => w.path),
      totalReplacements: writes.reduce((acc, w) => acc + w.count, 0),
    };
  });
}

// ─── Tag rename / delete (chriscase/abydonian#227) ──────────────────────────

export type TagMutationOutcome =
  | { kind: 'OK'; commitSha: string; filesChanged: string[] }
  | { kind: 'INVALID'; reason: string }
  | { kind: 'NOOP'; reason: string };

export interface TagRenameOptions {
  oldTag: string;
  newTag: string;
  author: { name: string; email: string };
  commitMessage?: string;
}

export interface TagDeleteOptions {
  tag: string;
  author: { name: string; email: string };
  commitMessage?: string;
}

const TAG_VALID_RE = /^[A-Za-z0-9_/\-]+$/;

/**
 * Rename a tag across every note's frontmatter. Skips auto-managed paths
 * (they're regenerated by the nightly script anyway). Single atomic commit.
 */
export async function renameTag(opts: TagRenameOptions): Promise<TagMutationOutcome> {
  return lock(async () => {
    const oldTag = opts.oldTag.trim();
    const newTag = opts.newTag.trim();
    if (!oldTag || !newTag) {
      return { kind: 'INVALID', reason: 'Both oldTag and newTag are required.' };
    }
    if (oldTag === newTag) {
      return { kind: 'INVALID', reason: 'oldTag and newTag are identical.' };
    }
    if (!TAG_VALID_RE.test(newTag)) {
      return {
        kind: 'INVALID',
        reason: 'New tag must be alphanumeric (with `_`, `-`, `/` allowed).',
      };
    }

    const idx = await getIndex();
    const writes: Array<{ path: string; content: string }> = [];

    for (const [path, meta] of idx.files) {
      if (meta.isAutoManaged) continue;
      if (!meta.tags.includes(oldTag)) continue;
      const current = await readVaultFile(path);
      const parsed = parseNote(current);
      const tags = parsed.data.tags ?? [];
      const next = tags
        .map((t) => (t === oldTag ? newTag : t))
        .filter((t, i, arr) => arr.indexOf(t) === i); // dedupe
      const newData: Frontmatter = { ...parsed.data, tags: next };
      const content = serializeNote(newData, parsed.content);
      if (content === current) continue;
      writes.push({ path, content });
    }

    if (writes.length === 0) {
      return { kind: 'NOOP', reason: `No notes use tag '${oldTag}'.` };
    }

    try {
      await pullRebase();
    } catch (err) {
      console.warn('[codex-sync] pre-tag-rename pull failed; proceeding:', err);
    }

    for (const w of writes) {
      await writeVaultFile(w.path, w.content);
    }
    const commitMessage =
      opts.commitMessage?.trim() ||
      `Rename tag #${oldTag} → #${newTag} across ${writes.length} note${writes.length === 1 ? '' : 's'}`;
    const commit = await commitFiles(
      writes.map((w) => w.path),
      commitMessage,
      opts.author,
    );

    invalidateIndex();
    invalidatePageRank();
    schedulePush();

    return {
      kind: 'OK',
      commitSha: commit.sha,
      filesChanged: writes.map((w) => w.path),
    };
  });
}

/**
 * Remove a tag from every note's frontmatter. Same shape as renameTag —
 * skips auto-managed paths and ships in one atomic commit.
 */
export async function deleteTag(opts: TagDeleteOptions): Promise<TagMutationOutcome> {
  return lock(async () => {
    const tag = opts.tag.trim();
    if (!tag) {
      return { kind: 'INVALID', reason: 'tag is required.' };
    }

    const idx = await getIndex();
    const writes: Array<{ path: string; content: string }> = [];

    for (const [path, meta] of idx.files) {
      if (meta.isAutoManaged) continue;
      if (!meta.tags.includes(tag)) continue;
      const current = await readVaultFile(path);
      const parsed = parseNote(current);
      const tags = parsed.data.tags ?? [];
      const next = tags.filter((t) => t !== tag);
      const newData: Frontmatter = { ...parsed.data, tags: next };
      const content = serializeNote(newData, parsed.content);
      if (content === current) continue;
      writes.push({ path, content });
    }

    if (writes.length === 0) {
      return { kind: 'NOOP', reason: `No notes use tag '${tag}'.` };
    }

    try {
      await pullRebase();
    } catch (err) {
      console.warn('[codex-sync] pre-tag-delete pull failed; proceeding:', err);
    }

    for (const w of writes) {
      await writeVaultFile(w.path, w.content);
    }
    const commitMessage =
      opts.commitMessage?.trim() ||
      `Delete tag #${tag} from ${writes.length} note${writes.length === 1 ? '' : 's'}`;
    const commit = await commitFiles(
      writes.map((w) => w.path),
      commitMessage,
      opts.author,
    );

    invalidateIndex();
    invalidatePageRank();
    schedulePush();

    return {
      kind: 'OK',
      commitSha: commit.sha,
      filesChanged: writes.map((w) => w.path),
    };
  });
}

/**
 * Compute tag → note-count + path list for the tag browser (#227).
 * Auto-managed notes are included in counts (they're real users of tags too)
 * but the rename / delete mutations skip them.
 */
export async function computeVaultTags(): Promise<
  Array<{ tag: string; count: number; notes: string[] }>
> {
  const idx = await getIndex();
  const map = new Map<string, string[]>();
  for (const [path, meta] of idx.files) {
    for (const tag of meta.tags) {
      const arr = map.get(tag) ?? [];
      arr.push(path);
      map.set(tag, arr);
    }
  }
  return [...map.entries()]
    .map(([tag, notes]) => ({
      tag,
      count: notes.length,
      notes: notes.sort(),
    }))
    .sort((a, b) => {
      // Highest count first, ties broken alphabetically by tag.
      if (b.count !== a.count) return b.count - a.count;
      return a.tag.localeCompare(b.tag);
    });
}

/**
 * Run a pull-only sync (used by the GitHub webhook). Acquires the mutex so it
 * can't race with an in-flight save.
 */
export async function syncFromRemote(): Promise<{ changed: boolean; output: string }> {
  return lock(async () => {
    const result = await pullRebase();
    if (result.changed) {
      invalidateIndex();
      invalidatePageRank();
    }
    return result;
  });
}

/** For tests: forcibly drain the mutex and clear any pending debounced push. */
export async function _resetSyncForTest(): Promise<void> {
  if (pushTimer) {
    clearTimeout(pushTimer);
    pushTimer = null;
  }
  await mutex.catch(() => undefined);
  mutex = Promise.resolve();
}
