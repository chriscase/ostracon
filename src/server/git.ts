// Thin simple-git wrapper for the vault repo. Every operation runs in the
// vault root and inherits the host's git config (so signing, identity, and
// remote auth come from whatever's already configured on the server). The
// sync coordinator (sync.ts) is the only caller — don't reach in directly.

import simpleGit, { type SimpleGit } from 'simple-git';
import { getVaultRoot } from './config';

let cached: SimpleGit | null = null;

export function getGit(): SimpleGit {
  if (!cached) {
    cached = simpleGit({ baseDir: getVaultRoot(), maxConcurrentProcesses: 1 });
  }
  return cached;
}

/** For tests: drop the cached client so a new vault root is picked up. */
export function resetGit(): void {
  cached = null;
}

export interface CommitResult {
  sha: string;
  filesChanged: string[];
}

/**
 * Stage the given relative paths, commit with the supplied message + author.
 * Returns the new HEAD SHA and the file list. Throws if there are no actual
 * changes (avoids empty commits — the saveNote resolver short-circuits before
 * calling this when content is unchanged).
 */
export async function commitFiles(
  paths: string[],
  message: string,
  author: { name: string; email: string },
): Promise<CommitResult> {
  const git = getGit();
  if (paths.length === 0) throw new Error('commitFiles called with no paths');
  await git.add(paths);

  // Detect a no-op commit BEFORE running git commit so we surface a clean error
  // (and avoid `--allow-empty` which would create dead commits in the vault).
  const status = await git.status();
  const stagedSet = new Set([
    ...status.staged,
    ...status.created,
    ...status.deleted,
    ...status.renamed.map((r) => r.to),
  ]);
  const actuallyStaged = paths.filter((p) => stagedSet.has(p));
  if (actuallyStaged.length === 0) {
    throw new Error('No changes to commit');
  }

  const result = await git.commit(message, paths, {
    '--author': `${author.name} <${author.email}>`,
  });
  return {
    sha: result.commit,
    filesChanged: actuallyStaged,
  };
}

/**
 * Pull from origin with rebase. Returns true if anything was actually pulled
 * (changed files), false on no-op. Caller invalidates the index either way.
 */
export async function pullRebase(): Promise<{ changed: boolean; output: string }> {
  const git = getGit();
  const result = await git.pull('origin', 'main', { '--rebase': 'true' });
  const changed = result.summary.changes > 0 || result.summary.insertions > 0 || result.summary.deletions > 0;
  return {
    changed,
    output: `${result.summary.changes} file(s) changed`,
  };
}

/** Push HEAD to origin/main. */
export async function push(): Promise<void> {
  const git = getGit();
  await git.push('origin', 'main');
}

/** Read the working-tree SHA of a single file. Used as a fallback when the index doesn't have it. */
export async function fileBlobSha(rel: string): Promise<string | null> {
  const git = getGit();
  try {
    const sha = await git.raw(['hash-object', rel]);
    return sha.trim();
  } catch {
    return null;
  }
}

// ─── History + revert (chriscase/abydonian#223 + #224) ─────────────────────

export interface CommitHistoryEntry {
  sha: string;
  shortSha: string;
  authorName: string;
  authorEmail: string;
  date: string; // ISO 8601
  message: string;
  /** Unified diff for this commit, scoped to the requested path. */
  diff: string;
  /** When the commit renamed the file, the previous path. */
  oldPath?: string;
}

/**
 * Return the commit history for a single vault path with `git log --follow`,
 * one entry per commit including a path-scoped unified diff. Used by the
 * history side panel (#223) and the revert dialog (#224).
 *
 * `limit` defaults to 50 — caller can request more, capped at 500 for
 * performance.
 */
export async function getFileHistory(
  rel: string,
  limit: number = 50,
): Promise<CommitHistoryEntry[]> {
  const git = getGit();
  const cap = Math.min(Math.max(limit, 1), 500);

  // Use a unique multi-character delimiter that won't appear in commit
  // messages or names. ASCII Unit Separator (0x1F) would be ideal but we
  // need something that round-trips through stdout cleanly across all
  // platforms; `<<<CODEX-FIELD>>>` is verbose but safe.
  const FS = '<<<CODEX-FIELD>>>';
  const RS = '<<<CODEX-RECORD>>>';
  const fmt = ['%H', '%h', '%aN', '%aE', '%aI', '%B'].join(FS);

  // git log --follow tracks renames; --no-merges keeps the history a clean
  // list of substantive edits.
  const raw = await git.raw([
    'log',
    `--follow`,
    `--no-merges`,
    `-n`,
    String(cap),
    `--pretty=format:${fmt}${RS}`,
    '--',
    rel,
  ]);

  const records = raw.split(RS).map((r) => r.trim()).filter(Boolean);
  const out: CommitHistoryEntry[] = [];
  for (const record of records) {
    const fields = record.split(FS);
    if (fields.length < 6) continue;
    const [sha, shortSha, authorName, authorEmail, date, ...rest] = fields;
    const message = rest.join(FS).trim();

    // Per-commit diff scoped to this path. `git show <sha> -- <path>` is
    // the simplest form; for renames `git log --follow` already maps the
    // path, so the show against the current path will sometimes be empty
    // for the rename commit itself. Fall back to `git show --follow` is
    // not supported — handle empty diff as "rename, no content change".
    let diff = '';
    try {
      diff = await git.raw([
        'show',
        '--no-color',
        '--format=',
        '--unified=3',
        sha,
        '--',
        rel,
      ]);
    } catch {
      // commit might predate the file's current path; fall back to a
      // path-less show truncated to a reasonable size.
      try {
        const full = await git.raw(['show', '--no-color', '--format=', sha]);
        diff = full.length > 32_000 ? full.slice(0, 32_000) + '\n... (diff truncated)' : full;
      } catch {
        diff = '';
      }
    }

    out.push({
      sha,
      shortSha,
      authorName,
      authorEmail,
      date,
      message,
      diff: diff.trimEnd(),
    });
  }

  return out;
}

/**
 * Read the contents of `rel` at a specific commit `sha`. Used by the
 * revert flow — fetch the historical content, write it back, commit. The
 * file may not exist at that sha (created later); we surface that as a
 * thrown error.
 */
export async function readFileAtSha(rel: string, sha: string): Promise<string> {
  const git = getGit();
  // `git show <sha>:<path>` outputs the raw blob.
  return git.raw(['show', `${sha}:${rel}`]);
}
