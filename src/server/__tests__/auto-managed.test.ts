import { describe, it, expect } from 'vitest';
import {
  splitAutoRegion,
  hasAutoRegion,
  replaceAutoRegion,
  isAutoManagedPath,
} from '../auto-managed';

const NOTE_WITH_ACTIVITY = `---
tags: [daily]
date: 2026-05-02
---

# 2026-05-02

## Sessions

- a manual session entry

## Activity (auto-mined 2026-05-02 13:12)
### NexaForge
- 05:12 657d416 — feat(export): vertical 9:16 + square 1:1 social-media presets

## Notes

- a note from the user
`;

const NOTE_WITHOUT_ACTIVITY = `---
tags: [product]
---

# NexaDeck

A description.

## Today

- bullet
`;

describe('splitAutoRegion', () => {
  it('separates the auto region from surrounding content', () => {
    const split = splitAutoRegion(NOTE_WITH_ACTIVITY);
    expect(split.autoRegion).not.toBeNull();
    expect(split.autoRegion).toContain('## Activity');
    expect(split.before).toContain('## Sessions');
    expect(split.after).toContain('## Notes');
  });

  it('returns null autoRegion when no Activity heading', () => {
    const split = splitAutoRegion(NOTE_WITHOUT_ACTIVITY);
    expect(split.autoRegion).toBeNull();
    expect(split.before).toBe(NOTE_WITHOUT_ACTIVITY);
    expect(split.after).toBe('');
  });

  it('round-trips: before + autoRegion + after === original', () => {
    const split = splitAutoRegion(NOTE_WITH_ACTIVITY);
    expect(split.before + split.autoRegion + split.after).toBe(NOTE_WITH_ACTIVITY);
  });
});

describe('hasAutoRegion', () => {
  it('detects presence of ## Activity', () => {
    expect(hasAutoRegion(NOTE_WITH_ACTIVITY)).toBe(true);
    expect(hasAutoRegion(NOTE_WITHOUT_ACTIVITY)).toBe(false);
  });
});

describe('replaceAutoRegion', () => {
  it('swaps in a new auto region body', () => {
    const replacement = '\n## Activity (auto-mined fresh)\n- new bullet\n';
    const out = replaceAutoRegion(NOTE_WITH_ACTIVITY, replacement);
    expect(out).toContain('## Activity (auto-mined fresh)');
    expect(out).toContain('- new bullet');
    expect(out).toContain('## Sessions');
    expect(out).toContain('## Notes');
    expect(out).not.toContain('657d416');
  });

  it('is a no-op when no auto region exists', () => {
    const out = replaceAutoRegion(NOTE_WITHOUT_ACTIVITY, '\n## Activity new\n- x\n');
    expect(out).toBe(NOTE_WITHOUT_ACTIVITY);
  });
});

describe('isAutoManagedPath', () => {
  it('flags Journals and Daily', () => {
    expect(isAutoManagedPath('70 - Journals/NexaDeck Journal.md')).toBe(true);
    expect(isAutoManagedPath('80 - Daily/2026/05/2026-05-02.md')).toBe(true);
  });
  it('does not flag Products or Architecture', () => {
    expect(isAutoManagedPath('20 - Products/NexaDeck.md')).toBe(false);
    expect(isAutoManagedPath('30 - Architecture/Auth & Licensing.md')).toBe(false);
  });
});
