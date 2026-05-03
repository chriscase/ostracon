// AbydosCodex vault filesystem config.
// Resolved lazily so tests can override $ABYDOS_VAULT_PATH after import.

import path from 'node:path';
import { homedir } from 'node:os';

const DEFAULT_VAULT_PATH = path.join(homedir(), 'Documents/GitHub/AbydosCodex');

export function getVaultRoot(): string {
  return path.resolve(process.env.ABYDOS_VAULT_PATH ?? DEFAULT_VAULT_PATH);
}

/**
 * Default folder where uploaded attachments land. Override with
 * `ABYDOS_ATTACHMENTS_DIR` (vault-relative path; no leading slash).
 *
 * The default `_attachments/` mirrors Obsidian's convention and lives under
 * the vault root so git tracks it like any other vault content. The leading
 * underscore keeps it out of the way alphabetically + signals "managed".
 */
export function getAttachmentsDir(): string {
  return process.env.ABYDOS_ATTACHMENTS_DIR ?? '_attachments';
}

/** Maximum upload size in bytes. Overridable via `ABYDOS_MAX_UPLOAD_BYTES`. */
export function getMaxUploadBytes(): number {
  const raw = process.env.ABYDOS_MAX_UPLOAD_BYTES;
  if (!raw) return 10 * 1024 * 1024; // 10 MB
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 10 * 1024 * 1024;
}

/**
 * Allowed file extensions for attachment upload (lowercased, no leading dot).
 * Overridable as a comma-separated list via `ABYDOS_ALLOWED_ATTACHMENT_EXTS`.
 */
export function getAllowedAttachmentExts(): ReadonlySet<string> {
  const raw = process.env.ABYDOS_ALLOWED_ATTACHMENT_EXTS;
  const fallback = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'pdf'];
  const list = raw
    ? raw
        .split(',')
        .map((s) => s.trim().replace(/^\./, '').toLowerCase())
        .filter(Boolean)
    : fallback;
  return new Set(list);
}
