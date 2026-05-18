// Unit tests for the UUID v7 generator. No filesystem or git involvement —
// purely format + collision properties.

import { describe, it, expect } from 'vitest';
import { generateUuidV7, isValidUuid } from '../uuid';

describe('generateUuidV7', () => {
  it('produces canonical 36-character UUID strings', () => {
    for (let i = 0; i < 50; i++) {
      const u = generateUuidV7();
      expect(u).toHaveLength(36);
      expect(u).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it('encodes version 7 in the right nibble', () => {
    for (let i = 0; i < 50; i++) {
      const u = generateUuidV7();
      // Version is the first nibble of the third group.
      expect(u[14]).toBe('7');
    }
  });

  it('encodes variant 10xx in the right nibble', () => {
    for (let i = 0; i < 50; i++) {
      const u = generateUuidV7();
      // Variant: first nibble of the fourth group must be 8, 9, a, or b.
      expect(['8', '9', 'a', 'b']).toContain(u[19]);
    }
  });

  it('sorts UUIDs chronologically (v7 property)', async () => {
    const u1 = generateUuidV7();
    // Tiny delay so the timestamp ms tick over.
    await new Promise((r) => setTimeout(r, 2));
    const u2 = generateUuidV7();
    expect(u1 < u2).toBe(true);
  });

  it('does not collide across many generations in a tight loop', () => {
    const set = new Set<string>();
    for (let i = 0; i < 1000; i++) set.add(generateUuidV7());
    expect(set.size).toBe(1000);
  });
});

describe('isValidUuid', () => {
  it('accepts well-formed v7 UUIDs', () => {
    expect(isValidUuid(generateUuidV7())).toBe(true);
  });

  it('accepts well-formed v4 UUIDs (loose validation)', () => {
    // v4 example
    expect(isValidUuid('550e8400-e29b-41d4-a716-446655440000')).toBe(true);
  });

  it('rejects garbage', () => {
    expect(isValidUuid('')).toBe(false);
    expect(isValidUuid('not-a-uuid')).toBe(false);
    expect(isValidUuid('123e4567-e89b-12d3-a456-42665544000g')).toBe(false); // 'g' at end
    expect(isValidUuid(undefined)).toBe(false);
    expect(isValidUuid(null)).toBe(false);
    expect(isValidUuid(42)).toBe(false);
    expect(isValidUuid({})).toBe(false);
  });
});
