import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  SandboxErrorKind,
  WorktreeSandboxProvider,
  type PinnedRepository,
  type RegisteredRepository,
  type RunWorktree,
} from '@kairo/sandbox-worktree';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

async function git(cwd: string, ...args: readonly string[]): Promise<string> {
  const child = Bun.spawn(['git', ...args], {
    cwd,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Kairo Test',
      GIT_AUTHOR_EMAIL: 'kairo@example.test',
      GIT_COMMITTER_NAME: 'Kairo Test',
      GIT_COMMITTER_EMAIL: 'kairo@example.test',
      GIT_AUTHOR_DATE: '2026-07-26T00:00:00.000Z',
      GIT_COMMITTER_DATE: '2026-07-26T00:00:00.000Z',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout.trim();
}

describe('WorktreeSandboxProvider', () => {
  let temporaryRoot: string;
  let repositoryPath: string;
  let managementRoot: string;
  let provider: WorktreeSandboxProvider;
  let repository: RegisteredRepository;
  let pinned: PinnedRepository;

  beforeEach(async () => {
    temporaryRoot = await mkdtemp(join(tmpdir(), 'kairo-worktree-test-'));
    repositoryPath = join(temporaryRoot, 'repository');
    managementRoot = join(temporaryRoot, 'management');
    await git(temporaryRoot, 'init', '--initial-branch=main', repositoryPath);
    await writeFile(join(repositoryPath, 'tracked.txt'), 'initial\n');
    await git(repositoryPath, 'add', 'tracked.txt');
    await git(repositoryPath, 'commit', '-m', 'initial');

    provider = new WorktreeSandboxProvider(managementRoot);
    expect((await provider.initialize()).isOk()).toBe(true);
    repository = (await provider.registerRepository('fixture', repositoryPath)).unwrap();
    pinned = (await provider.pinStartingCommit(repository)).unwrap();
  });

  afterEach(async () => {
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  test('pins a repository and isolates concurrent run worktrees', async () => {
    expect(pinned.startingCommit).toMatch(/^[0-9a-f]{40}$/);
    const secondProvider = new WorktreeSandboxProvider(managementRoot);
    expect((await secondProvider.initialize()).isOk()).toBe(true);

    const [first, second] = await Promise.all([
      provider.createWorktree(pinned, 'run-one'),
      secondProvider.createWorktree(pinned, 'run-two'),
    ]);
    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    const firstWorktree = first.unwrap();
    const secondWorktree = second.unwrap();
    expect(firstWorktree.path).not.toBe(secondWorktree.path);

    await writeFile(join(firstWorktree.path, 'tracked.txt'), 'run one\n');
    expect(await readFile(join(secondWorktree.path, 'tracked.txt'), 'utf8')).toBe('initial\n');
    expect(await git(repositoryPath, 'worktree', 'list', '--porcelain')).toContain(
      firstWorktree.path,
    );
    expect(await git(repositoryPath, 'worktree', 'list', '--porcelain')).toContain(
      secondWorktree.path,
    );
  });

  test('reconciles creation when the worktree exists but metadata was not recorded', async () => {
    const first = (await provider.createWorktree(pinned, 'interrupted-run')).unwrap();
    await unlink(join(managementRoot, 'runs', 'fixture', 'interrupted-run.json'));

    const restarted = new WorktreeSandboxProvider(managementRoot);
    expect((await restarted.initialize()).isOk()).toBe(true);
    const recovered = await restarted.createWorktree(pinned, 'interrupted-run');

    expect(recovered.isOk()).toBe(true);
    expect(recovered.unwrap()).toEqual(first);
    const listed = await git(repositoryPath, 'worktree', 'list', '--porcelain');
    expect(listed.split(`worktree ${first.path}`).length - 1).toBe(1);
  });

  test('writes checksum-bearing status and binary diff artifacts atomically', async () => {
    const worktree = (await provider.createWorktree(pinned, 'artifact-run')).unwrap();
    await writeFile(join(worktree.path, 'tracked.txt'), 'changed\n');
    await writeFile(join(worktree.path, 'untracked.txt'), 'new\n');

    const captured = await provider.captureArtifacts(worktree);

    expect(captured.isOk()).toBe(true);
    const artifacts = captured.unwrap();
    const status = await readFile(artifacts.status.path, 'utf8');
    const diff = await readFile(artifacts.diff.path, 'utf8');
    expect(status).toContain('tracked.txt');
    expect(status).toContain('untracked.txt');
    expect(diff).toContain('-initial');
    expect(diff).toContain('+changed');
    expect(artifacts.diff.checksum).toBe(createHash('sha256').update(diff).digest('hex'));
    expect(artifacts.diff.size).toBe(Buffer.byteLength(diff));
  });

  test('recovers an already-created controlled commit without duplicating it', async () => {
    const worktree = (await provider.createWorktree(pinned, 'commit-run')).unwrap();
    await writeFile(join(worktree.path, 'tracked.txt'), 'committed\n');
    const prepared = (await provider.prepareCommit(worktree)).unwrap();
    const input = {
      worktree,
      expectedHead: prepared.head,
      expectedTree: prepared.tree,
      message: 'controlled change',
      identity: {
        name: 'Kairo',
        email: 'kairo@example.test',
      },
      timestamp: '2026-07-26T01:02:03.000Z',
    } as const;

    const committed = await provider.commitWorktree(input);
    const recovered = await provider.commitWorktree(input);

    expect(committed.isOk()).toBe(true);
    expect(committed.unwrap().recovered).toBe(false);
    expect(recovered.isOk()).toBe(true);
    expect(recovered.unwrap()).toEqual({
      commit: committed.unwrap().commit,
      recovered: true,
    });
    expect(await git(worktree.path, 'rev-list', '--count', 'HEAD')).toBe('2');
    expect(await git(worktree.path, 'rev-parse', 'HEAD^{tree}')).toBe(prepared.tree);
  });

  test('rejects a changed tree and refuses dirty cleanup unless forced', async () => {
    const worktree: RunWorktree = (await provider.createWorktree(pinned, 'guarded-run')).unwrap();
    await writeFile(join(worktree.path, 'tracked.txt'), 'prepared\n');
    const prepared = (await provider.prepareCommit(worktree)).unwrap();
    await writeFile(join(worktree.path, 'tracked.txt'), 'changed afterward\n');

    const commit = await provider.commitWorktree({
      worktree,
      expectedHead: prepared.head,
      expectedTree: prepared.tree,
      message: 'must not commit',
      identity: {
        name: 'Kairo',
        email: 'kairo@example.test',
      },
      timestamp: '2026-07-26T01:02:03.000Z',
    });
    expect(commit.isErr()).toBe(true);
    if (commit.isErr()) expect(commit.error.kind).toBe(SandboxErrorKind.TreeConflict);

    const refused = await provider.cleanupWorktree(worktree);
    expect(refused.isErr()).toBe(true);
    if (refused.isErr()) expect(refused.error.kind).toBe(SandboxErrorKind.DirtyWorktree);
    expect((await provider.cleanupWorktree(worktree, true)).isOk()).toBe(true);
    expect(await git(repositoryPath, 'worktree', 'list', '--porcelain')).not.toContain(
      worktree.path,
    );
  });
});
