// UUID v7 generator (RFC 9562 §5.7).
//
// v7 packs the unix-epoch millisecond timestamp in the high 48 bits so
// UUIDs sort chronologically — useful when listing notes by creation
// order, keeping DB index leaf pages compact, or grouping commits by
// month without joining on mtime. The remaining 74 bits are random.
//
// We implement this in ~10 lines rather than pulling in the `uuid` npm
// package — Ostracon has zero runtime deps today and this is the only
// generator the codex needs.

import { randomBytes } from 'node:crypto';

/**
 * Generate a v7 (time-ordered) UUID as a canonical 36-character string,
 * lowercase, dash-separated.
 *
 * Format: aaaaaaaa-aaaa-7xxx-yxxx-xxxxxxxxxxxx
 *   • a... = 48-bit unix-epoch millisecond timestamp, big-endian
 *   • 7    = version 7
 *   • y    = variant (10xx, so y ∈ {8, 9, a, b})
 *   • x... = random
 */
export function generateUuidV7(): string {
  const buf = randomBytes(16);
  const ts = BigInt(Date.now());
  buf[0] = Number((ts >> 40n) & 0xffn);
  buf[1] = Number((ts >> 32n) & 0xffn);
  buf[2] = Number((ts >> 24n) & 0xffn);
  buf[3] = Number((ts >> 16n) & 0xffn);
  buf[4] = Number((ts >> 8n) & 0xffn);
  buf[5] = Number(ts & 0xffn);
  buf[6] = 0x70 | (buf[6] & 0x0f);
  buf[8] = 0x80 | (buf[8] & 0x3f);
  const hex = buf.toString('hex');
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32)
  );
}

/** Loose validation — accepts any RFC 4122-shaped UUID, not just v7. We're
 *  trusting whoever wrote the field; this only catches obvious corruption. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}
