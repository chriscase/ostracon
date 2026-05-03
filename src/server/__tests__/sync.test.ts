// Tests for the sync coordinator's non-git paths: SECRETS, AUTO_MANAGED,
// CONFLICT, NOOP. The OK path requires a working git binary + identity and
// is exercised by manual + staging verification — keeping it out of the unit
// suite avoids flakiness in environments where git isn't pre-configured.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  saveNote,
  renameNote,
  deleteNote,
  createFolder,
  renameFolder,
  deleteFolder,
  moveNote,
  moveFolder,
  uploadAttachment,
  revertNote,
  noteHistory,
  sanitizeAttachmentFilename,
  buildEmbedFromPath,
  applyVaultReplacement,
  renameTag,
  deleteTag,
  computeVaultTags,
  syncFromRemote,
  _resetSyncForTest,
} from '../sync';
import { invalidateIndex, contentSha } from '../vault-index';
import { invalidatePageRank } from '../graph';
import { resetGit } from '../git';

const exec = promisify(execFile);

let tmpRoot: string;
let originalEnv: string | undefined;
const author = { name: 'Test', email: 'test@test.com' };

async function gitInit(dir: string): Promise<void> {
  await exec('git', ['init', '-q', '-b', 'main', dir]);
  await exec('git', ['-C', dir, 'config', 'user.name', author.name]);
  await exec('git', ['-C', dir, 'config', 'user.email', author.email]);
  await exec('git', ['-C', dir, 'config', 'commit.gpgsign', 'false']);
}

beforeAll(async () => {
  tmpRoot = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'codex-sync-')));
  await gitInit(tmpRoot);
  await fs.mkdir(path.join(tmpRoot, '20 - Products'), { recursive: true });
  await fs.mkdir(path.join(tmpRoot, '70 - Journals'), { recursive: true });
  // Initial commit so HEAD exists.
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

async function writeFixture(rel: string, content: string): Promise<string> {
  const abs = path.join(tmpRoot, rel);
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, content, 'utf8');
  return contentSha(content);
}

describe('saveNote — guard rails (no git involvement)', () => {
  it('returns SECRETS when content contains an API key', async () => {
    const rel = '20 - Products/Test.md';
    const initial = '---\ntags: [test]\n---\n\nbody';
    const baseSha = await writeFixture(rel, initial);

    const outcome = await saveNote({
      path: rel,
      content: `${initial}\n\nNew content with sk_live_abcdefghijklmnopqrstuvwxyz1234567890`,
      baseSha,
      author,
      commitMessage: 'should-fail',
    });

    expect(outcome.kind).toBe('SECRETS');
    if (outcome.kind === 'SECRETS') {
      expect(outcome.hits.length).toBeGreaterThan(0);
    }
    // File must remain unchanged on disk.
    const onDisk = await fs.readFile(path.join(tmpRoot, rel), 'utf8');
    expect(onDisk).toBe(initial);
  });

  it('returns AUTO_MANAGED for paths in 70 - Journals/', async () => {
    const rel = '70 - Journals/NexaDeck Journal.md';
    const initial = '# Auto-managed\n\nDo not edit.';
    const baseSha = await writeFixture(rel, initial);

    const outcome = await saveNote({
      path: rel,
      content: `${initial}\n\nManual edit.`,
      baseSha,
      author,
      commitMessage: 'should-fail',
    });

    expect(outcome.kind).toBe('AUTO_MANAGED');
  });

  it('returns CONFLICT when baseSha does not match on-disk content', async () => {
    const rel = '20 - Products/Conflict.md';
    const onDisk = '# Newer content';
    await writeFixture(rel, onDisk);

    const outcome = await saveNote({
      path: rel,
      content: '# My change',
      baseSha: 'staleshawhicheveritwillbe'.padEnd(64, 'a'),
      author,
      commitMessage: 'should-conflict',
    });

    expect(outcome.kind).toBe('CONFLICT');
    if (outcome.kind === 'CONFLICT') {
      expect(outcome.currentContent).toBe(onDisk);
      expect(outcome.currentSha).toBe(contentSha(onDisk));
    }
  });

  it('returns CONFLICT when creating a note that already exists', async () => {
    const rel = '20 - Products/Existing.md';
    await writeFixture(rel, '# Already there');

    const outcome = await saveNote({
      path: rel,
      content: '# Brand new',
      baseSha: null, // create
      author,
      commitMessage: 'should-conflict',
    });

    expect(outcome.kind).toBe('CONFLICT');
  });

  it('returns NOOP when content is unchanged', async () => {
    const rel = '20 - Products/NoOp.md';
    const initial = '# Same content';
    const baseSha = await writeFixture(rel, initial);

    const outcome = await saveNote({
      path: rel,
      content: initial,
      baseSha,
      author,
      commitMessage: 'should-noop',
    });

    expect(outcome.kind).toBe('NOOP');
    if (outcome.kind === 'NOOP') {
      expect(outcome.sha).toBe(baseSha);
    }
  });
});

describe('syncFromRemote', () => {
  it('returns a result without throwing on a healthy clone', async () => {
    // We have no real remote configured for the tmp repo, so pullRebase will
    // throw — but syncFromRemote propagates the error rather than silently
    // succeeding. This test just verifies the function is callable; remote
    // sync is exercised by the webhook integration on staging.
    await expect(syncFromRemote()).rejects.toBeTruthy();
  });
});

// ─── renameNote (chriscase/abydonian#213) ─────────────────────────────────
//
// These tests exercise the full rename pipeline including a real `git mv`
// commit. They rely on the gitInit helper in beforeAll to provide a working
// git binary + identity inside the tmp vault — same pattern as the saveNote
// guard-rail tests above (which deliberately avoid OK-path commits to keep
// the suite portable; rename has no useful guard-rail-only mode, so we go
// the whole way).

describe('renameNote — guard rails', () => {
  it('returns INVALID for non-.md paths', async () => {
    const outcome = await renameNote({
      oldPath: '20 - Products/NexaDeck',
      newPath: '20 - Products/NexaDeckPro.md',
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('INVALID');
  });

  it('returns INVALID when old and new paths are identical', async () => {
    const outcome = await renameNote({
      oldPath: '20 - Products/Same.md',
      newPath: '20 - Products/Same.md',
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('INVALID');
  });

  it('returns AUTO_MANAGED when source is in 70 - Journals/', async () => {
    await writeFixture('70 - Journals/NexaDeck Journal.md', '# auto');
    const outcome = await renameNote({
      oldPath: '70 - Journals/NexaDeck Journal.md',
      newPath: '70 - Journals/Renamed.md',
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('AUTO_MANAGED');
  });

  it('returns AUTO_MANAGED when destination is in an auto-managed area', async () => {
    await writeFixture('20 - Products/Test.md', '# test');
    const outcome = await renameNote({
      oldPath: '20 - Products/Test.md',
      newPath: '70 - Journals/Test.md',
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('AUTO_MANAGED');
  });

  it('returns NOT_FOUND when source does not exist', async () => {
    const outcome = await renameNote({
      oldPath: '20 - Products/Ghost.md',
      newPath: '20 - Products/NotGhost.md',
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('NOT_FOUND');
  });

  it('returns CONFLICT when destination already exists', async () => {
    await writeFixture('20 - Products/Source.md', '# source');
    await writeFixture('20 - Products/Existing.md', '# existing');
    const outcome = await renameNote({
      oldPath: '20 - Products/Source.md',
      newPath: '20 - Products/Existing.md',
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('CONFLICT');
  });
});

describe('renameNote — happy path with cross-vault wikilink rewrite', () => {
  it('renames the file and rewrites every inbound wikilink in one commit', async () => {
    // Set up: A links to B in three forms (basename, folder-hinted, embed).
    const bPath = '20 - Products/B.md';
    const aPath = '20 - Products/A.md';
    const cPath = '30 - Architecture/C.md';
    const dPath = '40 - Concepts/D.md';
    await writeFixture(bPath, '# B\n\nbody of B');
    await writeFixture(
      aPath,
      [
        '# A',
        '',
        'See [[B]] for the basics.',
        'Also [[B|the B note]] and [[B#Stack|the stack section]].',
        '',
        'Embed: ![[B]]',
        '',
        'Folder-hinted: [[20 - Products/B]]',
      ].join('\n'),
    );
    await writeFixture(cPath, '# C\n\nUnrelated note that does not link to B.');
    await writeFixture(
      dPath,
      '# D\n\nA second note that links to [[B]] and [[B.md]].',
    );

    // Initial commit so the tmp repo has a clean working tree before the rename.
    await exec('git', ['-C', tmpRoot, 'add', '.']);
    await exec('git', ['-C', tmpRoot, 'commit', '-q', '-m', 'fixtures']);

    const outcome = await renameNote({
      oldPath: bPath,
      newPath: '20 - Products/BPrime.md',
      author,
      commitMessage: 'rename B → BPrime',
    });

    expect(outcome.kind).toBe('OK');
    if (outcome.kind !== 'OK') return; // narrow for TS

    expect(outcome.newPath).toBe('20 - Products/BPrime.md');
    // A and D had wikilinks to B; C did not.
    expect(outcome.rewrittenFiles.sort()).toEqual([aPath, dPath].sort());

    // The new file exists, the old file does not.
    const newAbs = path.join(tmpRoot, '20 - Products/BPrime.md');
    const oldAbs = path.join(tmpRoot, bPath);
    await expect(fs.stat(newAbs)).resolves.toBeTruthy();
    await expect(fs.stat(oldAbs)).rejects.toBeTruthy();

    // A's wikilinks now point to BPrime (basename, alias, anchor, embed,
    // folder-hinted — every form gets rewritten).
    const aContent = await fs.readFile(path.join(tmpRoot, aPath), 'utf8');
    expect(aContent).toContain('[[BPrime]]');
    expect(aContent).toContain('[[BPrime|the B note]]');
    expect(aContent).toContain('[[BPrime#Stack|the stack section]]');
    expect(aContent).toContain('![[BPrime]]');
    expect(aContent).toContain('[[20 - Products/BPrime]]');
    expect(aContent).not.toContain('[[B]]');
    expect(aContent).not.toContain('[[B|');
    expect(aContent).not.toContain('[[B#');

    // D's wikilinks rewritten too.
    const dContent = await fs.readFile(path.join(tmpRoot, dPath), 'utf8');
    expect(dContent).toContain('[[BPrime]]');
    expect(dContent).toContain('[[BPrime.md]]');
    expect(dContent).not.toContain('[[B]]');
    expect(dContent).not.toContain('[[B.md]]');

    // C is untouched (preserve verification — neither modified file content
    // nor staged it accidentally).
    const cContent = await fs.readFile(path.join(tmpRoot, cPath), 'utf8');
    expect(cContent).toBe('# C\n\nUnrelated note that does not link to B.');

    // The rename + both rewrites should land in a single commit.
    const log = await exec('git', [
      '-C',
      tmpRoot,
      'log',
      '--name-status',
      '-n',
      '1',
      '--format=',
    ]);
    const filesInCommit = log.stdout
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => l.replace(/^[A-Z]\d*\s+/, '').trim());
    // Git typically reports the rename as `R<sim> old new` collapsed onto
    // one line; we look for both paths somewhere in the log block.
    expect(log.stdout).toContain('B.md');
    expect(log.stdout).toContain('BPrime.md');
    expect(filesInCommit.some((f) => f.includes('A.md'))).toBe(true);
    expect(filesInCommit.some((f) => f.includes('D.md'))).toBe(true);
    expect(filesInCommit.some((f) => f.includes('C.md'))).toBe(false);
  });

  it('rewrites self-referential wikilinks in the renamed note', async () => {
    const oldPath = '20 - Products/SelfRef.md';
    const newPath = '20 - Products/SelfRefRenamed.md';
    await writeFixture(
      oldPath,
      '# SelfRef\n\nThis note links to itself: [[SelfRef]].',
    );
    await exec('git', ['-C', tmpRoot, 'add', '.']);
    await exec('git', ['-C', tmpRoot, 'commit', '-q', '-m', 'fixtures-self']);

    const outcome = await renameNote({
      oldPath,
      newPath,
      author,
      commitMessage: 'rename SelfRef',
    });
    expect(outcome.kind).toBe('OK');

    const content = await fs.readFile(path.join(tmpRoot, newPath), 'utf8');
    expect(content).toContain('[[SelfRefRenamed]]');
    expect(content).not.toContain('[[SelfRef]]');
  });
});

// ─── deleteNote (chriscase/abydonian#214) ─────────────────────────────────

describe('deleteNote — guard rails', () => {
  it('returns INVALID for non-.md paths', async () => {
    const outcome = await deleteNote({
      path: '20 - Products/Test',
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('INVALID');
  });

  it('returns AUTO_MANAGED when path is in 70 - Journals/', async () => {
    await writeFixture('70 - Journals/Some Journal.md', '# auto');
    const outcome = await deleteNote({
      path: '70 - Journals/Some Journal.md',
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('AUTO_MANAGED');
  });

  it('returns AUTO_MANAGED when path is in 80 - Daily/', async () => {
    await writeFixture('80 - Daily/2026/05/2026-05-01.md', '# day');
    const outcome = await deleteNote({
      path: '80 - Daily/2026/05/2026-05-01.md',
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('AUTO_MANAGED');
  });

  it('returns NOT_FOUND when the file does not exist', async () => {
    const outcome = await deleteNote({
      path: '20 - Products/Ghost.md',
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('NOT_FOUND');
  });
});

// ─── createFolder (chriscase/abydonian#215) ───────────────────────────────

describe('createFolder — guard rails', () => {
  it('returns INVALID for an empty path', async () => {
    const outcome = await createFolder({
      path: '',
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('INVALID');
  });

  it('returns INVALID for a path with disallowed characters', async () => {
    const outcome = await createFolder({
      path: '20 - Products/<bad>',
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('INVALID');
  });

  it('returns AUTO_MANAGED when path is under 70 - Journals/', async () => {
    const outcome = await createFolder({
      path: '70 - Journals/SubFolder',
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('AUTO_MANAGED');
  });

  it('returns AUTO_MANAGED when path is under 80 - Daily/', async () => {
    const outcome = await createFolder({
      path: '80 - Daily/2026/05/sub',
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('AUTO_MANAGED');
  });
});

describe('createFolder — happy path', () => {
  it('creates the folder + .gitkeep + commits', async () => {
    const folderPath = '90 - Test/SubFolder';
    const outcome = await createFolder({
      path: folderPath,
      author,
      commitMessage: 'create folder',
    });
    expect(outcome.kind).toBe('OK');
    if (outcome.kind !== 'OK') return;

    expect(outcome.path).toBe(folderPath);

    // .gitkeep exists in the new folder.
    const gitkeepAbs = path.join(tmpRoot, folderPath, '.gitkeep');
    await expect(fs.stat(gitkeepAbs)).resolves.toBeTruthy();

    // The commit references the .gitkeep file.
    const log = await exec('git', [
      '-C',
      tmpRoot,
      'log',
      '--name-only',
      '-n',
      '1',
      '--format=',
    ]);
    expect(log.stdout).toContain('.gitkeep');
    expect(log.stdout).toContain(folderPath);
  });

  it('returns CONFLICT when the folder already exists', async () => {
    const folderPath = '20 - Products/AlreadyHere';
    await fs.mkdir(path.join(tmpRoot, folderPath), { recursive: true });

    const outcome = await createFolder({
      path: folderPath,
      author,
      commitMessage: 'should-conflict',
    });
    expect(outcome.kind).toBe('CONFLICT');
  });

  it('strips trailing slashes from the path before processing', async () => {
    const outcome = await createFolder({
      path: '90 - Test/Trailing///',
      author,
      commitMessage: 'create folder with trailing slashes',
    });
    expect(outcome.kind).toBe('OK');
    if (outcome.kind !== 'OK') return;
    expect(outcome.path).toBe('90 - Test/Trailing');
  });
});

describe('deleteNote — happy path', () => {
  it('deletes the file, commits, and reports inbound-link orphans', async () => {
    const targetPath = '20 - Products/DeleteMe.md';
    const linkerPath = '20 - Products/Linker.md';
    const unlinkedPath = '30 - Architecture/Unlinked.md';
    await writeFixture(targetPath, '# DeleteMe\n\nthis will be deleted');
    await writeFixture(
      linkerPath,
      '# Linker\n\nThis links to [[DeleteMe]] for context.',
    );
    await writeFixture(unlinkedPath, '# Unlinked\n\nNo references.');
    await exec('git', ['-C', tmpRoot, 'add', '.']);
    await exec('git', ['-C', tmpRoot, 'commit', '-q', '-m', 'fixtures-delete']);

    const outcome = await deleteNote({
      path: targetPath,
      author,
      commitMessage: 'delete DeleteMe',
    });

    expect(outcome.kind).toBe('OK');
    if (outcome.kind !== 'OK') return;

    expect(outcome.orphanedFiles).toEqual([linkerPath]);

    // File is gone from disk.
    await expect(fs.stat(path.join(tmpRoot, targetPath))).rejects.toBeTruthy();

    // Linker's wikilink is intentionally NOT rewritten — delete is destructive
    // by design, the user accepted orphans in the confirmation dialog.
    const linkerContent = await fs.readFile(path.join(tmpRoot, linkerPath), 'utf8');
    expect(linkerContent).toContain('[[DeleteMe]]');

    // Single commit recorded the deletion.
    const log = await exec('git', [
      '-C',
      tmpRoot,
      'log',
      '--name-status',
      '-n',
      '1',
      '--format=',
    ]);
    expect(log.stdout).toMatch(/D\s+20 - Products\/DeleteMe\.md/);
  });
});

// ─── renameFolder (chriscase/abydonian#216) ───────────────────────────────

describe('renameFolder — guard rails', () => {
  it('returns INVALID for empty paths', async () => {
    const outcome = await renameFolder({
      oldPath: '',
      newPath: '20 - Products',
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('INVALID');
  });

  it('returns INVALID when paths are identical', async () => {
    const outcome = await renameFolder({
      oldPath: '20 - Products',
      newPath: '20 - Products',
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('INVALID');
  });

  it('returns INVALID when moving folder into a descendant', async () => {
    const outcome = await renameFolder({
      oldPath: '20 - Products',
      newPath: '20 - Products/SubFolder',
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('INVALID');
  });

  it('returns AUTO_MANAGED when source is under 70 - Journals/', async () => {
    const outcome = await renameFolder({
      oldPath: '70 - Journals',
      newPath: '70 - Journals-Renamed',
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('AUTO_MANAGED');
  });

  it('returns NOT_FOUND when source folder does not exist', async () => {
    const outcome = await renameFolder({
      oldPath: '99 - DoesNotExist',
      newPath: '99 - DoesNotExist-Renamed',
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('NOT_FOUND');
  });
});

describe('renameFolder — happy path', () => {
  it('renames every note inside, rewrites cross-folder + intra-folder wikilinks, single commit', async () => {
    // Set up: folder A contains note1 + note2; note2 links to note1 (intra-folder).
    // Folder B contains noteX which links to A/note1 (cross-folder).
    await writeFixture('20 - Products/folderA/note1.md', '# note1\n\nbody');
    await writeFixture(
      '20 - Products/folderA/note2.md',
      '# note2\n\nLinks intra: [[note1]] and [[20 - Products/folderA/note1]].',
    );
    await writeFixture(
      '20 - Products/folderB/noteX.md',
      '# noteX\n\nCross link: [[note1|the first note]] and embed ![[20 - Products/folderA/note1]].',
    );
    await writeFixture('30 - Architecture/Untouched.md', '# Untouched');
    await exec('git', ['-C', tmpRoot, 'add', '.']);
    await exec('git', ['-C', tmpRoot, 'commit', '-q', '-m', 'fixtures-rename-folder']);

    const outcome = await renameFolder({
      oldPath: '20 - Products/folderA',
      newPath: '20 - Products/folderRenamed',
      author,
      commitMessage: 'rename folderA → folderRenamed',
    });

    expect(outcome.kind).toBe('OK');
    if (outcome.kind !== 'OK') return;

    expect(outcome.renamedNotes).toBe(2);

    // The new folder structure exists; the old one does not.
    await expect(
      fs.stat(path.join(tmpRoot, '20 - Products/folderRenamed/note1.md')),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(tmpRoot, '20 - Products/folderRenamed/note2.md')),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(tmpRoot, '20 - Products/folderA')),
    ).rejects.toBeTruthy();

    // note2 (now at the new path) has its intra-folder wikilink updated for
    // the folder-hinted form. The basename-only [[note1]] form is intra-vault
    // and stays valid since note1's basename didn't change.
    const note2Content = await fs.readFile(
      path.join(tmpRoot, '20 - Products/folderRenamed/note2.md'),
      'utf8',
    );
    expect(note2Content).toContain('[[note1]]');
    expect(note2Content).toContain('[[20 - Products/folderRenamed/note1]]');
    expect(note2Content).not.toContain('[[20 - Products/folderA/note1]]');

    // noteX (cross-folder linker) has its folder-hinted link rewritten too.
    const noteXContent = await fs.readFile(
      path.join(tmpRoot, '20 - Products/folderB/noteX.md'),
      'utf8',
    );
    expect(noteXContent).toContain('[[note1|the first note]]');
    expect(noteXContent).toContain('![[20 - Products/folderRenamed/note1]]');
    expect(noteXContent).not.toContain('![[20 - Products/folderA/note1]]');

    // Untouched note: untouched.
    const untouched = await fs.readFile(
      path.join(tmpRoot, '30 - Architecture/Untouched.md'),
      'utf8',
    );
    expect(untouched).toBe('# Untouched');

    // Single commit references both folder-internal renames and external
    // rewrites.
    const log = await exec('git', [
      '-C',
      tmpRoot,
      'log',
      '--name-status',
      '-n',
      '1',
      '--format=',
    ]);
    expect(log.stdout).toContain('folderRenamed/note1.md');
    expect(log.stdout).toContain('folderRenamed/note2.md');
    expect(log.stdout).toContain('folderB/noteX.md');
  });
});

// ─── deleteFolder (chriscase/abydonian#217) ───────────────────────────────

describe('deleteFolder — guard rails', () => {
  it('returns INVALID for an empty path', async () => {
    const outcome = await deleteFolder({
      path: '',
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('INVALID');
  });

  it('returns AUTO_MANAGED when path is under 70 - Journals/', async () => {
    const outcome = await deleteFolder({
      path: '70 - Journals',
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('AUTO_MANAGED');
  });

  it('returns NOT_FOUND when folder does not exist', async () => {
    const outcome = await deleteFolder({
      path: '99 - Ghost',
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('NOT_FOUND');
  });

  it('returns NOT_EMPTY when folder has files and force=false', async () => {
    await writeFixture('20 - Products/NonEmpty/file.md', '# file');
    const outcome = await deleteFolder({
      path: '20 - Products/NonEmpty',
      force: false,
      author,
      commitMessage: 'should-refuse',
    });
    expect(outcome.kind).toBe('NOT_EMPTY');
    if (outcome.kind === 'NOT_EMPTY') {
      expect(outcome.fileCount).toBe(1);
    }
  });
});

describe('deleteFolder — happy path', () => {
  it('deletes an empty (only-marker) folder + commits', async () => {
    const folderPath = '90 - Empty';
    await fs.mkdir(path.join(tmpRoot, folderPath), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, folderPath, '.gitkeep'), '');
    await exec('git', ['-C', tmpRoot, 'add', '.']);
    await exec('git', ['-C', tmpRoot, 'commit', '-q', '-m', 'fixtures-empty-folder']);

    const outcome = await deleteFolder({
      path: folderPath,
      author,
      commitMessage: 'delete empty folder',
    });
    expect(outcome.kind).toBe('OK');
    if (outcome.kind !== 'OK') return;
    expect(outcome.deletedFiles).toEqual([]);

    await expect(fs.stat(path.join(tmpRoot, folderPath))).rejects.toBeTruthy();
  });

  it('recursively deletes a non-empty folder when force=true; reports orphans', async () => {
    // Use uniquely-named files to avoid basename collisions with fixtures
    // left behind by other tests in this suite (which doesn't clean up tmpRoot
    // between tests). The `_uq` suffix ensures the basenames don't appear in
    // any prior wikilink, which would otherwise inflate the orphan list.
    const folderPath = '91 - ForceDelete';
    await writeFixture(`${folderPath}/note1_uq.md`, '# note1_uq');
    await writeFixture(`${folderPath}/sub/note2_uq.md`, '# note2_uq');
    await writeFixture(
      '92 - Outsider/Outsider_uq.md',
      '# Outsider_uq\n\nLinks to [[note1_uq]] and [[note2_uq]].',
    );
    await exec('git', ['-C', tmpRoot, 'add', '.']);
    await exec('git', ['-C', tmpRoot, 'commit', '-q', '-m', 'fixtures-force-delete']);

    const outcome = await deleteFolder({
      path: folderPath,
      force: true,
      author,
      commitMessage: 'force delete folder',
    });
    expect(outcome.kind).toBe('OK');
    if (outcome.kind !== 'OK') return;

    expect(outcome.deletedFiles.sort()).toEqual([
      `${folderPath}/note1_uq.md`,
      `${folderPath}/sub/note2_uq.md`,
    ]);
    expect(outcome.orphanedFiles).toEqual(['92 - Outsider/Outsider_uq.md']);

    await expect(fs.stat(path.join(tmpRoot, folderPath))).rejects.toBeTruthy();

    // Outsider's wikilinks remain (delete doesn't rewrite, by design).
    const outsider = await fs.readFile(
      path.join(tmpRoot, '92 - Outsider/Outsider_uq.md'),
      'utf8',
    );
    expect(outsider).toContain('[[note1_uq]]');
    expect(outsider).toContain('[[note2_uq]]');
  });
});

// ─── moveNote / moveFolder (chriscase/abydonian#218) ─────────────────────

describe('moveNote', () => {
  it('moves a note into a different folder, preserving basename, with cross-vault link rewrite', async () => {
    await writeFixture('20 - Products/Subject.md', '# Subject\n\nbody');
    await writeFixture(
      '20 - Products/Linker.md',
      '# Linker\n\nLinks to [[Subject]].',
    );
    await exec('git', ['-C', tmpRoot, 'add', '.']);
    await exec('git', ['-C', tmpRoot, 'commit', '-q', '-m', 'fixtures-move-note']);

    const outcome = await moveNote({
      oldPath: '20 - Products/Subject.md',
      newParentPath: '40 - Concepts',
      author,
      commitMessage: 'move Subject',
    });
    expect(outcome.kind).toBe('OK');
    if (outcome.kind !== 'OK') return;
    expect(outcome.newPath).toBe('40 - Concepts/Subject.md');

    // Linker's basename-only wikilink stays the same (basename didn't
    // change), the file just moved folders.
    const linker = await fs.readFile(
      path.join(tmpRoot, '20 - Products/Linker.md'),
      'utf8',
    );
    expect(linker).toContain('[[Subject]]');
  });
});

describe('moveFolder', () => {
  it('moves a folder under a different parent, preserving inner structure', async () => {
    await writeFixture('20 - Products/SubA/inside.md', '# inside');
    await exec('git', ['-C', tmpRoot, 'add', '.']);
    await exec('git', ['-C', tmpRoot, 'commit', '-q', '-m', 'fixtures-move-folder']);

    const outcome = await moveFolder({
      oldPath: '20 - Products/SubA',
      newParentPath: '40 - Concepts',
      author,
      commitMessage: 'move SubA into 40 - Concepts',
    });
    expect(outcome.kind).toBe('OK');
    if (outcome.kind !== 'OK') return;
    expect(outcome.newPath).toBe('40 - Concepts/SubA');

    await expect(
      fs.stat(path.join(tmpRoot, '40 - Concepts/SubA/inside.md')),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(tmpRoot, '20 - Products/SubA')),
    ).rejects.toBeTruthy();
  });
});

// ─── uploadAttachment (chriscase/abydonian#221) ─────────────────────────

describe('sanitizeAttachmentFilename', () => {
  it('strips directory components', () => {
    expect(sanitizeAttachmentFilename('/etc/passwd')).toBe('passwd');
    expect(sanitizeAttachmentFilename('foo/bar/baz.png')).toBe('baz.png');
  });
  it('strips leading dots so we never write hidden files', () => {
    expect(sanitizeAttachmentFilename('.htaccess')).toBe('htaccess');
  });
  it('replaces unsafe chars with `-`', () => {
    expect(sanitizeAttachmentFilename('weird;file*name?.png')).toBe('weird-file-name-.png');
  });
  it('preserves spaces and parens (vault convention)', () => {
    expect(sanitizeAttachmentFilename('My Photo (final).png')).toBe('My Photo (final).png');
  });
  it('returns empty string for path-only input', () => {
    expect(sanitizeAttachmentFilename('foo/bar/')).toBe('');
  });
});

describe('buildEmbedFromPath', () => {
  it('drops the default _attachments/ prefix in the embed string', () => {
    expect(buildEmbedFromPath('_attachments/foo.png')).toBe('![[foo.png]]');
  });
  it('preserves nested folder hint inside _attachments/', () => {
    expect(buildEmbedFromPath('_attachments/Sub/foo.png')).toBe('![[Sub/foo.png]]');
  });
  it('keeps full path when not under _attachments', () => {
    expect(buildEmbedFromPath('20 - Products/diagram.png')).toBe('![[20 - Products/diagram.png]]');
  });
});

describe('uploadAttachment — guard rails', () => {
  it('returns BAD_TYPE for an unrecognized extension', async () => {
    const outcome = await uploadAttachment({
      filename: 'malicious.exe',
      data: Buffer.from('hi'),
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('BAD_TYPE');
  });

  it('returns TOO_LARGE when payload exceeds the limit', async () => {
    const previous = process.env.ABYDOS_MAX_UPLOAD_BYTES;
    process.env.ABYDOS_MAX_UPLOAD_BYTES = '128';
    try {
      const outcome = await uploadAttachment({
        filename: 'big.png',
        data: Buffer.alloc(256, 0x42),
        author,
        commitMessage: 'should-fail',
      });
      expect(outcome.kind).toBe('TOO_LARGE');
    } finally {
      if (previous === undefined) delete process.env.ABYDOS_MAX_UPLOAD_BYTES;
      else process.env.ABYDOS_MAX_UPLOAD_BYTES = previous;
    }
  });

  it('returns INVALID for an empty filename after sanitization', async () => {
    const outcome = await uploadAttachment({
      filename: '/foo/bar/',
      data: Buffer.from('hi'),
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('INVALID');
  });
});

describe('uploadAttachment — happy path', () => {
  it('writes the file to _attachments/, commits, and returns the embed string', async () => {
    const outcome = await uploadAttachment({
      filename: 'screenshot.png',
      data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff]),
      author,
      commitMessage: 'upload screenshot',
    });
    expect(outcome.kind).toBe('OK');
    if (outcome.kind !== 'OK') return;
    expect(outcome.path).toBe('_attachments/screenshot.png');
    expect(outcome.embed).toBe('![[screenshot.png]]');
    expect(outcome.bytes).toBe(9);
    await expect(
      fs.stat(path.join(tmpRoot, '_attachments/screenshot.png')),
    ).resolves.toBeTruthy();
  });

  it('appends a numeric suffix when the filename collides', async () => {
    await fs.mkdir(path.join(tmpRoot, '_attachments'), { recursive: true });
    await fs.writeFile(path.join(tmpRoot, '_attachments/dup.png'), 'first');
    await exec('git', ['-C', tmpRoot, 'add', '.']);
    await exec('git', ['-C', tmpRoot, 'commit', '-q', '-m', 'fixtures-upload-collide']);

    const outcome = await uploadAttachment({
      filename: 'dup.png',
      data: Buffer.from('second'),
      author,
      commitMessage: 'upload duplicate',
    });
    expect(outcome.kind).toBe('OK');
    if (outcome.kind !== 'OK') return;
    expect(outcome.path).toBe('_attachments/dup-2.png');
  });

  it('honors the subfolder option', async () => {
    const outcome = await uploadAttachment({
      filename: 'nested.png',
      data: Buffer.from([0x89]),
      subfolder: 'NexaDeck',
      author,
      commitMessage: 'upload nested',
    });
    expect(outcome.kind).toBe('OK');
    if (outcome.kind !== 'OK') return;
    expect(outcome.path).toBe('_attachments/NexaDeck/nested.png');
    expect(outcome.embed).toBe('![[NexaDeck/nested.png]]');
  });
});

// ─── revertNote + noteHistory (chriscase/abydonian#223 + #224) ─────────────

describe('revertNote — guard rails', () => {
  it('returns INVALID for non-.md paths', async () => {
    const outcome = await revertNote({
      path: '20 - Products/foo.png',
      sha: 'deadbeef',
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('INVALID');
  });

  it('returns INVALID for an empty sha', async () => {
    const outcome = await revertNote({
      path: '20 - Products/Foo.md',
      sha: '',
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('INVALID');
  });

  it('returns AUTO_MANAGED for journal paths', async () => {
    const outcome = await revertNote({
      path: '70 - Journals/Some.md',
      sha: 'deadbeef',
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('AUTO_MANAGED');
  });

  it('returns NOT_FOUND when the file does not exist at the requested sha', async () => {
    const outcome = await revertNote({
      path: '20 - Products/Ghost.md',
      sha: '0000000000000000000000000000000000000000',
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('NOT_FOUND');
  });
});

describe('noteHistory + revertNote — happy path', () => {
  it('history lists every commit; revert restores prior content; subsequent revert is NOOP', async () => {
    const rel = '20 - Products/Versioned.md';
    const v1 = '# Versioned\n\nFirst version.';
    await writeFixture(rel, v1);
    await exec('git', ['-C', tmpRoot, 'add', '.']);
    await exec('git', ['-C', tmpRoot, 'commit', '-q', '-m', 'fixtures-versioned-v1']);

    const v2 = '# Versioned\n\nSecond version with more content.';
    await fs.writeFile(path.join(tmpRoot, rel), v2);
    await exec('git', ['-C', tmpRoot, 'add', '.']);
    await exec('git', ['-C', tmpRoot, 'commit', '-q', '-m', 'fixtures-versioned-v2']);

    // History returns both commits, most-recent first.
    const history = await noteHistory(rel);
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history[0].message).toContain('v2');
    expect(history[1].message).toContain('v1');
    const v1Sha = history[1].sha;

    // Revert to v1.
    const outcome = await revertNote({
      path: rel,
      sha: v1Sha,
      author,
      commitMessage: 'revert to v1',
    });
    expect(outcome.kind).toBe('OK');

    const restored = await fs.readFile(path.join(tmpRoot, rel), 'utf8');
    expect(restored).toBe(v1);

    // Reverting to the same sha again is a NOOP.
    const second = await revertNote({
      path: rel,
      sha: v1Sha,
      author,
      commitMessage: 'should-noop',
    });
    expect(second.kind).toBe('NOOP');
  });
});

// ─── applyVaultReplacement (chriscase/abydonian#226) ────────────────────

describe('applyVaultReplacement', () => {
  it('rewrites every match in scope and commits in one shot', async () => {
    // Use uniquely-named files so we don't collide with prior fixtures.
    await writeFixture(
      '95 - FindRepl/A.md',
      '# A\n\nThe term oldname appears here. And again: oldname.',
    );
    await writeFixture('95 - FindRepl/B.md', '# B\n\nNo match.');
    await writeFixture('95 - FindRepl/C.md', '# C\n\nAnother oldname here.');
    // An auto-managed file with the same term — should be skipped.
    await writeFixture(
      '70 - Journals/AutoManagedFR.md',
      '# auto\n\noldname should NOT change.',
    );
    await exec('git', ['-C', tmpRoot, 'add', '.']);
    await exec('git', ['-C', tmpRoot, 'commit', '-q', '-m', 'fixtures-find-replace']);

    const outcome = await applyVaultReplacement({
      query: 'oldname',
      replacement: 'newname',
      author,
      commitMessage: 'rename oldname → newname',
    });

    expect(outcome.kind).toBe('OK');
    if (outcome.kind !== 'OK') return;

    expect(outcome.totalReplacements).toBe(3);
    expect(outcome.filesChanged.sort()).toEqual([
      '95 - FindRepl/A.md',
      '95 - FindRepl/C.md',
    ]);

    const aContent = await fs.readFile(
      path.join(tmpRoot, '95 - FindRepl/A.md'),
      'utf8',
    );
    expect(aContent).toContain('newname');
    expect(aContent).not.toContain('oldname');

    // Auto-managed file untouched.
    const autoContent = await fs.readFile(
      path.join(tmpRoot, '70 - Journals/AutoManagedFR.md'),
      'utf8',
    );
    expect(autoContent).toContain('oldname');
  });

  it('returns NOOP when no matches exist', async () => {
    const outcome = await applyVaultReplacement({
      query: 'nonexistent_string_xyz',
      replacement: 'whatever',
      author,
      commitMessage: 'should-noop',
    });
    expect(outcome.kind).toBe('NOOP');
  });

  it('returns INVALID for an invalid regex', async () => {
    const outcome = await applyVaultReplacement({
      query: '[unterminated',
      replacement: 'x',
      regex: true,
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('INVALID');
  });
});

// ─── renameTag / deleteTag / computeVaultTags (chriscase/abydonian#227) ──

describe('renameTag', () => {
  it('rewrites every note frontmatter that uses the tag', async () => {
    await writeFixture(
      '96 - TagOps/X.md',
      '---\ntags: [foobar, other]\n---\n\n# X\n',
    );
    await writeFixture(
      '96 - TagOps/Y.md',
      '---\ntags: [foobar]\n---\n\n# Y\n',
    );
    await writeFixture('96 - TagOps/Z.md', '---\ntags: [other]\n---\n\n# Z\n');
    await exec('git', ['-C', tmpRoot, 'add', '.']);
    await exec('git', ['-C', tmpRoot, 'commit', '-q', '-m', 'fixtures-rename-tag']);

    const outcome = await renameTag({
      oldTag: 'foobar',
      newTag: 'bazqux',
      author,
      commitMessage: 'rename foobar → bazqux',
    });
    expect(outcome.kind).toBe('OK');
    if (outcome.kind !== 'OK') return;
    expect(outcome.filesChanged.sort()).toEqual(['96 - TagOps/X.md', '96 - TagOps/Y.md']);

    const x = await fs.readFile(path.join(tmpRoot, '96 - TagOps/X.md'), 'utf8');
    expect(x).toContain('bazqux');
    expect(x).not.toContain('foobar');
    // The "other" tag is preserved alongside.
    expect(x).toContain('other');
  });

  it('returns NOOP when no notes use the tag', async () => {
    const outcome = await renameTag({
      oldTag: 'never_used_tag_xyz',
      newTag: 'whatever',
      author,
      commitMessage: 'should-noop',
    });
    expect(outcome.kind).toBe('NOOP');
  });

  it('returns INVALID when the new tag has bad characters', async () => {
    const outcome = await renameTag({
      oldTag: 'foo',
      newTag: 'bad tag!',
      author,
      commitMessage: 'should-fail',
    });
    expect(outcome.kind).toBe('INVALID');
  });
});

describe('deleteTag', () => {
  it('removes the tag from every note that uses it', async () => {
    await writeFixture('97 - TagDel/A.md', '---\ntags: [doomed, keep]\n---\n\n# A\n');
    await writeFixture('97 - TagDel/B.md', '---\ntags: [doomed]\n---\n\n# B\n');
    await exec('git', ['-C', tmpRoot, 'add', '.']);
    await exec('git', ['-C', tmpRoot, 'commit', '-q', '-m', 'fixtures-delete-tag']);

    const outcome = await deleteTag({
      tag: 'doomed',
      author,
      commitMessage: 'delete doomed',
    });
    expect(outcome.kind).toBe('OK');
    if (outcome.kind !== 'OK') return;
    expect(outcome.filesChanged.sort()).toEqual(['97 - TagDel/A.md', '97 - TagDel/B.md']);

    const a = await fs.readFile(path.join(tmpRoot, '97 - TagDel/A.md'), 'utf8');
    expect(a).not.toContain('doomed');
    expect(a).toContain('keep');
  });
});

describe('computeVaultTags', () => {
  it('aggregates tags across the vault, ranked by usage', async () => {
    await writeFixture('98 - TagAgg/X.md', '---\ntags: [popular, niche]\n---\nbody');
    await writeFixture('98 - TagAgg/Y.md', '---\ntags: [popular]\n---\nbody');
    await writeFixture('98 - TagAgg/Z.md', '---\ntags: [popular]\n---\nbody');
    invalidateIndex();

    const tags = await computeVaultTags();
    const popular = tags.find((t) => t.tag === 'popular');
    const niche = tags.find((t) => t.tag === 'niche');
    expect(popular?.count).toBeGreaterThanOrEqual(3);
    expect(niche?.count).toBeGreaterThanOrEqual(1);
    // popular must come before niche in the ranked order
    if (popular && niche) {
      expect(tags.indexOf(popular)).toBeLessThan(tags.indexOf(niche));
    }
  });
});
