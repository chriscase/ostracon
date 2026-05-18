// Contract tests for EventAdapter integration in the sync coordinator.
// Verifies that a registered adapter receives the expected event shape
// after each mutation. Filesystem-backed because the events fire from
// inside the sync mutex against real git operations.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { saveNote, renameNote, deleteNote, _resetSyncForTest } from '../sync';
import { invalidateIndex, contentSha } from '../vault-index';
import { invalidatePageRank } from '../graph';
import { resetGit } from '../git';
import type { EventAdapter, VaultEvent } from '../event-adapter';

const exec = promisify(execFile);

let tmpRoot: string;
let originalEnv: string | undefined;
const author = { name: 'Test', email: 'test@test.com' };
const user = { id: 'user-1', name: 'Test', email: 'test@test.com' };

async function gitInit(dir: string): Promise<void> {
  await exec('git', ['init', '-q', '-b', 'main', dir]);
  await exec('git', ['-C', dir, 'config', 'user.name', author.name]);
  await exec('git', ['-C', dir, 'config', 'user.email', author.email]);
  await exec('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
}

function recordingAdapter(): { adapter: EventAdapter; events: VaultEvent[] } {
  const events: VaultEvent[] = [];
  return {
    events,
    adapter: { emit: (e) => void events.push(e) },
  };
}

beforeAll(async () => {
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codex-events-')));
  await gitInit(tmpRoot);
  await fs.mkdir(path.join(tmpRoot, '20 - Products'), { recursive: true });
  await fs.writeFile(path.join(tmpRoot, 'README.md'), '# Codex\n');
  await exec('git', ['-C', tmpRoot, 'add', '.']);
  await exec('git', ['-C', tmpRoot, 'commit', '-q', '-m', 'init']);
  originalEnv = process.env.ABYDOS_VAULT_PATH;
  process.env.ABYDOS_VAULT_PATH = tmpRoot;
});

beforeEach(async () => {
  invalidateIndex();
  invalidatePageRank();
  resetGit();
  await _resetSyncForTest();
});

afterEach(async () => {
  await _resetSyncForTest();
});

afterAll(async () => {
  if (originalEnv === undefined) delete process.env.ABYDOS_VAULT_PATH;
  else process.env.ABYDOS_VAULT_PATH = originalEnv;
  await fs.rm(tmpRoot, { recursive: true, force: true });
});

describe('EventAdapter — saveNote', () => {
  it('emits note.created on a brand-new file', async () => {
    const { adapter, events } = recordingAdapter();
    const outcome = await saveNote({
      path: '20 - Products/EventCreate.md',
      content: '---\ntags: [test]\n---\n\nbody',
      baseSha: null,
      author,
      commitMessage: 'create',
      events: adapter,
      user,
    });
    expect(outcome.kind).toBe('OK');
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('note.created');
    if (events[0].kind === 'note.created') {
      expect(events[0].path).toBe('20 - Products/EventCreate.md');
      expect(events[0].uuid).toMatch(/^[0-9a-f-]{36}$/);
      expect(events[0].commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(events[0].author.email).toBe('test@test.com');
    }
  });

  it('emits note.saved on an update to an existing file', async () => {
    const { adapter, events } = recordingAdapter();
    // First, create.
    const initial = await saveNote({
      path: '20 - Products/EventUpdate.md',
      content: '---\ntags: [test]\n---\n\nv1',
      baseSha: null,
      author,
      commitMessage: 'create',
      events: adapter,
    });
    expect(initial.kind).toBe('OK');
    if (initial.kind !== 'OK') return;

    // Then update with the new sha.
    const after = await fs.readFile(
      path.join(tmpRoot, '20 - Products/EventUpdate.md'),
      'utf8',
    );
    const edited = after.replace('v1', 'v2');
    const outcome = await saveNote({
      path: '20 - Products/EventUpdate.md',
      content: edited,
      baseSha: contentSha(after),
      author,
      commitMessage: 'update',
      events: adapter,
    });
    expect(outcome.kind).toBe('OK');
    expect(events).toHaveLength(2);
    expect(events[1].kind).toBe('note.saved');
  });

  it('does NOT emit on CONFLICT', async () => {
    await fs.writeFile(
      path.join(tmpRoot, '20 - Products/EventConflict.md'),
      'existing',
      'utf8',
    );
    await exec('git', ['-C', tmpRoot, 'add', '.']);
    await exec('git', ['-C', tmpRoot, 'commit', '-q', '-m', 'conflict-fixture']);
    const { adapter, events } = recordingAdapter();
    const outcome = await saveNote({
      path: '20 - Products/EventConflict.md',
      content: 'new',
      baseSha: 'wrong-sha',
      author,
      commitMessage: 'should-conflict',
      events: adapter,
    });
    expect(outcome.kind).toBe('CONFLICT');
    expect(events).toHaveLength(0);
  });
});

describe('EventAdapter — renameNote', () => {
  it('emits note.renamed with the original UUID + both paths', async () => {
    const { adapter, events } = recordingAdapter();
    await saveNote({
      path: '20 - Products/EventRenameSrc.md',
      content: '---\ntags: [test]\n---\n\nbody',
      baseSha: null,
      author,
      commitMessage: 'create',
      events: adapter,
    });
    const createdUuid = events[0].kind === 'note.created' ? events[0].uuid : null;
    events.length = 0;

    invalidateIndex();
    const outcome = await renameNote({
      oldPath: '20 - Products/EventRenameSrc.md',
      newPath: '20 - Products/EventRenameDest.md',
      author,
      commitMessage: 'rename',
      events: adapter,
    });
    expect(outcome.kind).toBe('OK');
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('note.renamed');
    if (events[0].kind === 'note.renamed') {
      expect(events[0].oldPath).toBe('20 - Products/EventRenameSrc.md');
      expect(events[0].newPath).toBe('20 - Products/EventRenameDest.md');
      expect(events[0].uuid).toBe(createdUuid);
    }
  });
});

describe('EventAdapter — deleteNote', () => {
  it('emits note.deleted with the UUID of the deleted note', async () => {
    const { adapter, events } = recordingAdapter();
    await saveNote({
      path: '20 - Products/EventDelete.md',
      content: '---\ntags: [test]\n---\n\nbody',
      baseSha: null,
      author,
      commitMessage: 'create',
      events: adapter,
    });
    const createdUuid = events[0].kind === 'note.created' ? events[0].uuid : null;
    events.length = 0;

    invalidateIndex();
    const outcome = await deleteNote({
      path: '20 - Products/EventDelete.md',
      author,
      commitMessage: 'delete',
      events: adapter,
    });
    expect(outcome.kind).toBe('OK');
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('note.deleted');
    if (events[0].kind === 'note.deleted') {
      expect(events[0].path).toBe('20 - Products/EventDelete.md');
      expect(events[0].uuid).toBe(createdUuid);
    }
  });
});

describe('EventAdapter — no-op when adapter not supplied', () => {
  it('saveNote succeeds without events when opts.events is omitted', async () => {
    const outcome = await saveNote({
      path: '20 - Products/EventNoneSupplied.md',
      content: '---\ntags: [test]\n---\n\nbody',
      baseSha: null,
      author,
      commitMessage: 'no-events',
    });
    expect(outcome.kind).toBe('OK');
  });
});
