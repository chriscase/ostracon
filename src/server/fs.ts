// Path-traversal-safe filesystem access for the AbydosCodex vault.
// Every read/write MUST go through resolveVaultPath to prevent escape.

import path from 'node:path';
import fs from 'node:fs/promises';
import { getVaultRoot } from './config';

export class PathTraversalError extends Error {
  constructor(rel: string) {
    super(`Refused: '${rel}' resolves outside the vault root`);
    this.name = 'PathTraversalError';
  }
}

function withinVault(absPath: string): boolean {
  const root = getVaultRoot();
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  return absPath === root || absPath.startsWith(withSep);
}

export function resolveVaultPath(rel: string): string {
  if (typeof rel !== 'string' || rel.length === 0) {
    throw new PathTraversalError(String(rel));
  }
  if (path.isAbsolute(rel)) {
    throw new PathTraversalError(rel);
  }
  if (rel.includes('\0')) {
    throw new PathTraversalError(rel);
  }
  const root = getVaultRoot();
  const normalized = path.resolve(path.join(root, rel));
  if (!withinVault(normalized)) {
    throw new PathTraversalError(rel);
  }
  return normalized;
}

export async function readVaultFile(rel: string): Promise<string> {
  const abs = resolveVaultPath(rel);
  const real = await fs.realpath(abs).catch(() => abs);
  if (!withinVault(real)) {
    throw new PathTraversalError(rel);
  }
  return fs.readFile(real, 'utf8');
}

export async function statVaultFile(rel: string) {
  const abs = resolveVaultPath(rel);
  return fs.stat(abs);
}

export async function vaultExists(): Promise<boolean> {
  try {
    const stat = await fs.stat(getVaultRoot());
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Write a file to the vault. The relative path must be `.md` and resolve
 * inside the vault root (path-traversal guarded). Parent directories are
 * created on demand so callers can write into a brand-new folder.
 */
export async function writeVaultFile(rel: string, content: string): Promise<void> {
  if (!rel.endsWith('.md')) {
    throw new Error(`writeVaultFile only accepts .md paths; got '${rel}'`);
  }
  const abs = resolveVaultPath(rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
}

/**
 * Returns true if the vault file exists at the given relative path.
 * Used to distinguish create vs update at save time.
 */
export async function vaultFileExists(rel: string): Promise<boolean> {
  try {
    const abs = resolveVaultPath(rel);
    const stat = await fs.stat(abs);
    return stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Read a binary file from the vault (used for attachment serving by the
 * blob route, chriscase/abydonian#222). Returns the raw bytes; the caller
 * is responsible for sniffing/setting Content-Type.
 *
 * Path-traversal guarded; symlinks resolved + re-checked.
 */
export async function readVaultBinary(rel: string): Promise<Buffer> {
  const abs = resolveVaultPath(rel);
  const real = await fs.realpath(abs).catch(() => abs);
  if (!withinVault(real)) {
    throw new PathTraversalError(rel);
  }
  return fs.readFile(real);
}

/**
 * Write a binary file to the vault (used for attachment uploads,
 * chriscase/abydonian#221). Unlike writeVaultFile, this accepts any
 * extension — the caller is responsible for validating the extension
 * against an allow-list. Parent directories are created on demand.
 */
export async function writeVaultBinary(rel: string, data: Buffer): Promise<void> {
  const abs = resolveVaultPath(rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, data);
}
