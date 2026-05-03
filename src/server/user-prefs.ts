// AbydosCodex per-user prefs — recents + pinned (chriscase/abydonian#228).
//
// Persisted in `CodexUserPref` (one row per user). Both lists are simple
// string[] of vault-relative paths; the canonical truth lives in the vault
// repo, so a stale entry just renders as a non-clickable row in the sidebar
// rather than crashing anything.
//
// `bumpCodexRecent()` is the workhorse — called when the admin opens or
// edits a note. It moves the path to the front of the list and caps at
// RECENTS_CAP. Pinned operations are simple set-membership toggles.

import type { PrismaClient } from '@prisma/client';

export const RECENTS_CAP = 10;

export interface CodexUserPrefs {
  recentPaths: string[];
  pinnedPaths: string[];
  updatedAt: Date;
}

function emptyPrefs(): CodexUserPrefs {
  // Used as the implicit default when a user has never touched the codex
  // browser. updatedAt is `now` so the GraphQL field is always non-null.
  return { recentPaths: [], pinnedPaths: [], updatedAt: new Date() };
}

export async function getCodexUserPrefs(
  prisma: PrismaClient,
  userId: string,
): Promise<CodexUserPrefs> {
  const row = await prisma.codexUserPref.findUnique({ where: { userId } });
  if (!row) return emptyPrefs();
  return {
    recentPaths: row.recentPaths,
    pinnedPaths: row.pinnedPaths,
    updatedAt: row.updatedAt,
  };
}

/**
 * Bump a path to the front of the recent list. Cap at RECENTS_CAP. Idempotent
 * if `path` is already at the head.
 */
export async function bumpCodexRecent(
  prisma: PrismaClient,
  userId: string,
  path: string,
): Promise<CodexUserPrefs> {
  const trimmed = path.trim();
  if (!trimmed) {
    return getCodexUserPrefs(prisma, userId);
  }
  // Read-modify-write: simpler than trying to express "prepend + dedup + cap"
  // as a single Prisma update. Race conditions are acceptable here — the
  // recent list is best-effort UX, not a system of record.
  const current = await getCodexUserPrefs(prisma, userId);
  if (current.recentPaths[0] === trimmed) {
    return current;
  }
  const filtered = current.recentPaths.filter((p) => p !== trimmed);
  const next = [trimmed, ...filtered].slice(0, RECENTS_CAP);
  const row = await prisma.codexUserPref.upsert({
    where: { userId },
    update: { recentPaths: next, updatedAt: new Date() },
    create: { userId, recentPaths: next, pinnedPaths: current.pinnedPaths },
  });
  return {
    recentPaths: row.recentPaths,
    pinnedPaths: row.pinnedPaths,
    updatedAt: row.updatedAt,
  };
}

/** Add a path to the pinned set (no-op if already pinned). */
export async function pinCodexNote(
  prisma: PrismaClient,
  userId: string,
  path: string,
): Promise<CodexUserPrefs> {
  const trimmed = path.trim();
  if (!trimmed) return getCodexUserPrefs(prisma, userId);
  const current = await getCodexUserPrefs(prisma, userId);
  if (current.pinnedPaths.includes(trimmed)) return current;
  const next = [...current.pinnedPaths, trimmed];
  const row = await prisma.codexUserPref.upsert({
    where: { userId },
    update: { pinnedPaths: next, updatedAt: new Date() },
    create: { userId, pinnedPaths: next, recentPaths: current.recentPaths },
  });
  return {
    recentPaths: row.recentPaths,
    pinnedPaths: row.pinnedPaths,
    updatedAt: row.updatedAt,
  };
}

/** Remove a path from the pinned set (no-op if not pinned). */
export async function unpinCodexNote(
  prisma: PrismaClient,
  userId: string,
  path: string,
): Promise<CodexUserPrefs> {
  const trimmed = path.trim();
  if (!trimmed) return getCodexUserPrefs(prisma, userId);
  const current = await getCodexUserPrefs(prisma, userId);
  if (!current.pinnedPaths.includes(trimmed)) return current;
  const next = current.pinnedPaths.filter((p) => p !== trimmed);
  const row = await prisma.codexUserPref.upsert({
    where: { userId },
    update: { pinnedPaths: next, updatedAt: new Date() },
    create: { userId, pinnedPaths: next, recentPaths: current.recentPaths },
  });
  return {
    recentPaths: row.recentPaths,
    pinnedPaths: row.pinnedPaths,
    updatedAt: row.updatedAt,
  };
}
