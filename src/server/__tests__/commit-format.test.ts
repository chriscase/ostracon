// Unit tests for buildCodexCommitMessage.
//
// The structure of every commit produced by Ostracon's mutation
// resolvers is here. Downstream tooling (audit log, search-index
// sync, MCP audit) parses these messages — keep the shape contract
// tight.

import { describe, it, expect } from 'vitest';
import { buildCodexCommitMessage } from '../commit-format';

describe('buildCodexCommitMessage — subject lines', () => {
  it('builds an edit subject with the basename + host tag', () => {
    const msg = buildCodexCommitMessage({
      verb: 'edit',
      path: '20 - Products/NexaDeck.md',
      editedVia: 'HallOfRecords v1',
    });
    expect(msg.split('\n')[0]).toBe('edit: NexaDeck.md via HallOfRecords v1');
  });

  it('falls back to "Ostracon" when editedVia is omitted', () => {
    const msg = buildCodexCommitMessage({ verb: 'edit', path: 'Foo.md' });
    expect(msg.split('\n')[0]).toBe('edit: Foo.md via Ostracon');
  });

  it('truncates long subjects to stay under 72 chars', () => {
    const veryLongName = 'A'.repeat(120) + '.md';
    const msg = buildCodexCommitMessage({
      verb: 'edit',
      path: veryLongName,
      editedVia: 'Tag',
    });
    const subject = msg.split('\n')[0];
    expect(subject.length).toBeLessThanOrEqual(72);
    expect(subject.endsWith(' via Tag')).toBe(true);
    expect(subject).toContain('…');
  });

  it('uses arrow + new basename for rename', () => {
    const msg = buildCodexCommitMessage({
      verb: 'rename',
      path: '20 - Products/Old.md',
      newPath: '20 - Products/New.md',
      editedVia: 'Host',
    });
    expect(msg.split('\n')[0]).toBe('rename: Old.md → New.md via Host');
  });

  it('uses short SHA for revert', () => {
    const msg = buildCodexCommitMessage({
      verb: 'revert',
      path: 'X.md',
      toSha: 'abcdef1234567890',
      editedVia: 'Host',
    });
    expect(msg.split('\n')[0]).toBe('revert: X.md to abcdef1 via Host');
  });

  it('uses query → replacement for find-replace', () => {
    const msg = buildCodexCommitMessage({
      verb: 'find-replace',
      path: 'foo → bar',
      editedVia: 'Host',
    });
    expect(msg.split('\n')[0]).toBe('find-replace: foo → bar via Host');
  });
});

describe('buildCodexCommitMessage — body + trailers', () => {
  it('includes user message as the body when provided', () => {
    const msg = buildCodexCommitMessage({
      verb: 'edit',
      path: 'X.md',
      userMessage: 'Clarified the kwa cue.',
      editedVia: 'Host',
    });
    const sections = msg.split('\n\n');
    expect(sections[1]).toBe('Clarified the kwa cue.');
  });

  it('skips the body when userMessage is empty/undefined', () => {
    const msg = buildCodexCommitMessage({
      verb: 'edit',
      path: 'X.md',
      editedVia: 'Host',
    });
    const sections = msg.split('\n\n');
    expect(sections).toHaveLength(2); // subject + trailers, no body
  });

  it('emits standard trailers for note ops', () => {
    const msg = buildCodexCommitMessage({
      verb: 'edit',
      path: '20 - Products/NexaDeck.md',
      uuid: '0190f3b5-2c3a-7f4a-8a6c-9d3e1f5a4b62',
      editedVia: 'HallOfRecords v1',
    });
    expect(msg).toContain('Note-Path: 20 - Products/NexaDeck.md');
    expect(msg).toContain('Note-UUID: 0190f3b5-2c3a-7f4a-8a6c-9d3e1f5a4b62');
    expect(msg).toContain('Edited-Via: HallOfRecords v1');
  });

  it('omits Note-UUID when uuid is absent', () => {
    const msg = buildCodexCommitMessage({
      verb: 'edit',
      path: 'X.md',
      editedVia: 'Host',
    });
    expect(msg).not.toContain('Note-UUID:');
    expect(msg).toContain('Note-Path: X.md');
    expect(msg).toContain('Edited-Via: Host');
  });

  it('emits Note-New-Path on rename/move', () => {
    const msg = buildCodexCommitMessage({
      verb: 'rename',
      path: 'A.md',
      newPath: 'B.md',
      editedVia: 'Host',
    });
    expect(msg).toContain('Note-Path: A.md');
    expect(msg).toContain('Note-New-Path: B.md');
  });

  it('emits Revert-To-SHA on revert', () => {
    const msg = buildCodexCommitMessage({
      verb: 'revert',
      path: 'X.md',
      toSha: 'deadbeefcafebabe',
      editedVia: 'Host',
    });
    expect(msg).toContain('Revert-To-SHA: deadbeefcafebabe');
  });

  it('uses Folder-Path trailer for folder ops (no Note-Path)', () => {
    const msg = buildCodexCommitMessage({
      verb: 'rename-folder',
      path: '20 - Products',
      newPath: '20 - Apps',
      editedVia: 'Host',
    });
    expect(msg).toContain('Folder-Path: 20 - Products');
    expect(msg).toContain('Folder-New-Path: 20 - Apps');
    expect(msg).not.toContain('Note-Path:');
  });

  it('uses Tag trailer for tag ops', () => {
    const msg = buildCodexCommitMessage({
      verb: 'rename-tag',
      path: 'oldtag',
      newPath: 'newtag',
      editedVia: 'Host',
    });
    expect(msg).toContain('Tag: oldtag');
    expect(msg).toContain('Tag-New: newtag');
  });

  it('emits no Note-Path / Folder-Path / Tag trailer for find-replace', () => {
    const msg = buildCodexCommitMessage({
      verb: 'find-replace',
      path: 'foo → bar',
      editedVia: 'Host',
    });
    expect(msg).not.toContain('Note-Path:');
    expect(msg).not.toContain('Folder-Path:');
    expect(msg).not.toContain('Tag:');
    expect(msg).toContain('Edited-Via: Host');
  });
});

describe('buildCodexCommitMessage — full output shape', () => {
  it('emits subject, blank, body, blank, trailers', () => {
    const msg = buildCodexCommitMessage({
      verb: 'edit',
      path: '20 - Products/NexaDeck.md',
      uuid: '0190f3b5-2c3a-7f4a-8a6c-9d3e1f5a4b62',
      userMessage: 'Clarified the kwa cue.',
      editedVia: 'HallOfRecords v1',
    });
    expect(msg).toBe(
      [
        'edit: NexaDeck.md via HallOfRecords v1',
        '',
        'Clarified the kwa cue.',
        '',
        'Note-Path: 20 - Products/NexaDeck.md',
        'Note-UUID: 0190f3b5-2c3a-7f4a-8a6c-9d3e1f5a4b62',
        'Edited-Via: HallOfRecords v1',
      ].join('\n'),
    );
  });
});
