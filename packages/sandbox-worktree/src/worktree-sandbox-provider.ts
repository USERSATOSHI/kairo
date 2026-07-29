import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { err, fromAsync, ok, safeCall, type Result } from '@usersatoshi/results';

import { SandboxErrorKind, type SandboxError, toErr } from './errors.ts';
import { GitCommandRunner } from './git-command-runner.ts';
import type {
  CommitResult,
  CommitWorktreeInput,
  GitArtifact,
  GitArtifactKind,
  PinnedRepository,
  PreparedCommit,
  RegisteredRepository,
  RunWorktree,
  WorktreeArtifacts,
} from './types.ts';

interface LockRecord {
  readonly processId: number;
  readonly token: string;
}

interface AcquiredLock extends LockRecord {
  readonly path: string;
}

export interface WorktreeSandboxOptions {
  readonly lockTimeoutMs?: number;
  readonly lockRetryMs?: number;
}

const identifierPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : 'Filesystem operation failed';
}

function filesystemError(operation: string, error: unknown): SandboxError {
  return toErr(SandboxErrorKind.FilesystemFailure, {
    operation,
    message: messageFor(error),
    ...(errorCode(error) ? { code: errorCode(error) } : {}),
  });
}

function filesystemCode(error: SandboxError): string | undefined {
  return error.kind === SandboxErrorKind.FilesystemFailure ? error.code : undefined;
}

function validateIdentifier(
  field: 'repositoryId' | 'runId',
  value: string,
): Result<void, SandboxError> {
  return identifierPattern.test(value)
    ? ok(undefined)
    : err(toErr(SandboxErrorKind.InvalidIdentifier, { field, value }));
}

function isRegisteredRepository(value: unknown): value is RegisteredRepository {
  return (
    isRecord(value) &&
    typeof value.repositoryId === 'string' &&
    typeof value.repositoryPath === 'string' &&
    typeof value.commonGitDirectory === 'string'
  );
}

function isRunWorktree(value: unknown): value is RunWorktree {
  return (
    isRecord(value) &&
    typeof value.repositoryId === 'string' &&
    typeof value.runId === 'string' &&
    typeof value.repositoryPath === 'string' &&
    typeof value.path === 'string' &&
    typeof value.commonGitDirectory === 'string' &&
    typeof value.startingCommit === 'string'
  );
}

function sameWorktree(left: RunWorktree, right: RunWorktree): boolean {
  return (
    left.repositoryId === right.repositoryId &&
    left.runId === right.runId &&
    left.repositoryPath === right.repositoryPath &&
    left.path === right.path &&
    left.commonGitDirectory === right.commonGitDirectory &&
    left.startingCommit === right.startingCommit
  );
}

function isLockRecord(value: unknown): value is LockRecord {
  return (
    isRecord(value) && Number.isSafeInteger(value.processId) && typeof value.token === 'string'
  );
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

function isCanonicalTimestamp(value: string): boolean {
  const timestamp = new Date(value);
  return !Number.isNaN(timestamp.getTime()) && timestamp.toISOString() === value;
}

export class WorktreeSandboxProvider {
  private initialized = false;
  private readonly lockRetryMs: number;
  private readonly lockTimeoutMs: number;

  constructor(
    private readonly managementRoot: string,
    private readonly git: GitCommandRunner = new GitCommandRunner(),
    options: WorktreeSandboxOptions = {},
  ) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? 10_000;
    this.lockRetryMs = options.lockRetryMs ?? 20;
  }

  async initialize(): Promise<Result<void, SandboxError>> {
    const initialized = await fromAsync(
      async () => {
        await Promise.all([
          mkdir(resolve(this.managementRoot, 'artifacts'), { recursive: true }),
          mkdir(resolve(this.managementRoot, 'locks'), { recursive: true }),
          mkdir(resolve(this.managementRoot, 'repositories'), { recursive: true }),
          mkdir(resolve(this.managementRoot, 'runs'), { recursive: true }),
          mkdir(resolve(this.managementRoot, 'worktrees'), { recursive: true }),
        ]);
      },
      (error) => filesystemError('initialize', error),
    );
    if (initialized.isOk()) this.initialized = true;
    return initialized;
  }

  async registerRepository(
    repositoryId: string,
    repositoryPath: string,
  ): Promise<Result<RegisteredRepository, SandboxError>> {
    const ready = this.validateReady();
    if (ready.isErr()) return ready;
    const identifier = validateIdentifier('repositoryId', repositoryId);
    if (identifier.isErr()) return identifier;

    const canonicalInput = await this.canonicalPath(repositoryPath, 'register repository');
    if (canonicalInput.isErr()) return canonicalInput;
    const root = await this.git.run(canonicalInput.unwrap(), 'resolve repository root', [
      'rev-parse',
      '--show-toplevel',
    ]);
    if (root.isErr()) return root;
    const repositoryRoot = await this.canonicalPath(
      root.unwrap().stdout.trim(),
      'resolve repository root',
    );
    if (repositoryRoot.isErr()) return repositoryRoot;
    const common = await this.git.run(repositoryRoot.unwrap(), 'resolve common Git directory', [
      'rev-parse',
      '--git-common-dir',
    ]);
    if (common.isErr()) return common;
    const commonDirectory = await this.canonicalPath(
      resolve(repositoryRoot.unwrap(), common.unwrap().stdout.trim()),
      'resolve common Git directory',
    );
    if (commonDirectory.isErr()) return commonDirectory;

    const registration: RegisteredRepository = {
      repositoryId,
      repositoryPath: repositoryRoot.unwrap(),
      commonGitDirectory: commonDirectory.unwrap(),
    };
    return this.withRepositoryLock(registration, async () => {
      const metadataPath = this.repositoryMetadataPath(repositoryId);
      const existing = await this.readJson(metadataPath, isRegisteredRepository);
      if (existing.isErr()) return existing;
      const current = existing.unwrap();
      if (current) {
        return current.repositoryPath === registration.repositoryPath &&
          current.commonGitDirectory === registration.commonGitDirectory
          ? ok(current)
          : err(toErr(SandboxErrorKind.RegistrationConflict, { repositoryId }));
      }
      const written = await this.writeJsonAtomic(metadataPath, registration);
      return written.isErr() ? written : ok(registration);
    });
  }

  async pinStartingCommit(
    repository: RegisteredRepository,
    reference = 'HEAD',
  ): Promise<Result<PinnedRepository, SandboxError>> {
    const ready = this.validateReady();
    if (ready.isErr()) return ready;
    const verified = await this.verifyRegistration(repository);
    if (verified.isErr()) return verified;
    const resolvedCommit = await this.git.run(repository.repositoryPath, 'pin starting commit', [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${reference}^{commit}`,
    ]);
    if (resolvedCommit.isErr()) return resolvedCommit;
    return ok({
      ...repository,
      startingCommit: resolvedCommit.unwrap().stdout.trim(),
    });
  }

  async resolveBaseBranch(
    repository: PinnedRepository,
    explicit?: string,
  ): Promise<Result<string, SandboxError>> {
    const branch = explicit
      ? ok({ stdout: explicit })
      : await this.git.run(repository.repositoryPath, 'resolve base branch', [
          'symbolic-ref',
          '--quiet',
          '--short',
          'HEAD',
        ]);
    if (branch.isErr()) {
      return err(
        toErr(SandboxErrorKind.WorktreeConflict, {
          runId: repository.repositoryId,
          path: repository.repositoryPath,
          reason: 'detached repositories require an explicit base branch',
        }),
      );
    }
    const name = branch.value.stdout.trim();
    const resolved = await this.git.run(repository.repositoryPath, 'verify base branch', [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${name}^{commit}`,
    ]);
    if (resolved.isErr()) return resolved;
    return resolved.value.stdout.trim() === repository.startingCommit
      ? ok(name)
      : err(
          toErr(SandboxErrorKind.HeadConflict, {
            runId: repository.repositoryId,
            expected: repository.startingCommit,
            received: resolved.value.stdout.trim(),
          }),
        );
  }

  async pushDeliveryBranch(
    worktree: RunWorktree,
    remote: string,
    branch: string,
    commit: string,
  ): Promise<Result<void, SandboxError>> {
    const ready = this.validateReady();
    if (ready.isErr()) return ready;
    return this.withRepositoryLock(worktree, async () => {
      const remoteBranch = await this.git.run(worktree.repositoryPath, 'inspect remote branch', [
        'ls-remote',
        '--heads',
        remote,
        `refs/heads/${branch}`,
      ]);
      if (remoteBranch.isErr()) return remoteBranch;
      const remoteCommit = remoteBranch.value.stdout.trim().split(/\s+/)[0] ?? '';
      if (remoteCommit) {
        return remoteCommit === commit
          ? ok(undefined)
          : err(
              toErr(SandboxErrorKind.HeadConflict, {
                runId: worktree.runId,
                expected: commit,
                received: remoteCommit,
              }),
            );
      }
      const pushed = await this.git.run(worktree.repositoryPath, 'push delivery branch', [
        'push',
        remote,
        `${commit}:refs/heads/${branch}`,
      ]);
      return pushed.isErr() ? pushed : ok(undefined);
    });
  }

  async remoteUrl(worktree: RunWorktree, remote: string): Promise<Result<string, SandboxError>> {
    const value = await this.git.run(worktree.repositoryPath, 'read remote URL', [
      'remote',
      'get-url',
      remote,
    ]);
    return value.isErr() ? value : ok(value.value.stdout.trim());
  }

  async createWorktree(
    repository: PinnedRepository,
    runId: string,
  ): Promise<Result<RunWorktree, SandboxError>> {
    const ready = this.validateReady();
    if (ready.isErr()) return ready;
    const runIdentifier = validateIdentifier('runId', runId);
    if (runIdentifier.isErr()) return runIdentifier;
    const verified = await this.verifyRegistration(repository);
    if (verified.isErr()) return verified;

    return this.withRepositoryLock(repository, async () => {
      const expected: RunWorktree = {
        repositoryId: repository.repositoryId,
        runId,
        repositoryPath: repository.repositoryPath,
        path: this.worktreePath(repository.repositoryId, runId),
        commonGitDirectory: repository.commonGitDirectory,
        startingCommit: repository.startingCommit,
      };
      const metadataPath = this.runMetadataPath(repository.repositoryId, runId);
      const metadata = await this.readJson(metadataPath, isRunWorktree);
      if (metadata.isErr()) return metadata;
      const recorded = metadata.unwrap();
      if (recorded && !sameWorktree(recorded, expected)) {
        return err(
          toErr(SandboxErrorKind.WorktreeConflict, {
            runId,
            path: expected.path,
            reason: 'recorded worktree identity does not match the request',
          }),
        );
      }

      const pathPresent = await this.pathExists(expected.path);
      if (pathPresent.isErr()) return pathPresent;
      if (pathPresent.unwrap()) {
        const reconciled = await this.reconcileWorktree(expected);
        if (reconciled.isErr()) return reconciled;
      } else {
        const parentCreated = await this.createDirectory(dirname(expected.path));
        if (parentCreated.isErr()) return parentCreated;
        const created = await this.git.run(repository.repositoryPath, 'create run worktree', [
          'worktree',
          'add',
          '--detach',
          expected.path,
          expected.startingCommit,
        ]);
        if (created.isErr()) return created;
      }

      const written = await this.writeJsonAtomic(metadataPath, expected);
      return written.isErr() ? written : ok(expected);
    });
  }

  async prepareCommit(worktree: RunWorktree): Promise<Result<PreparedCommit, SandboxError>> {
    const ready = this.validateReady();
    if (ready.isErr()) return ready;
    return this.withRepositoryLock(worktree, async () => {
      const verified = await this.verifyWorktree(worktree);
      if (verified.isErr()) return verified;
      const staged = await this.git.run(worktree.path, 'stage worktree', ['add', '--all']);
      if (staged.isErr()) return staged;
      const [head, tree] = await Promise.all([
        this.git.run(worktree.path, 'read worktree HEAD', ['rev-parse', 'HEAD']),
        this.git.run(worktree.path, 'write worktree tree', ['write-tree']),
      ]);
      if (head.isErr()) return head;
      if (tree.isErr()) return tree;
      return ok({
        head: head.unwrap().stdout.trim(),
        tree: tree.unwrap().stdout.trim(),
      });
    });
  }

  async commitWorktree(input: CommitWorktreeInput): Promise<Result<CommitResult, SandboxError>> {
    const ready = this.validateReady();
    if (ready.isErr()) return ready;
    if (!isCanonicalTimestamp(input.timestamp)) {
      return err(
        toErr(SandboxErrorKind.WorktreeConflict, {
          runId: input.worktree.runId,
          path: input.worktree.path,
          reason: 'commit timestamp must be a canonical ISO-8601 timestamp',
        }),
      );
    }
    return this.withRepositoryLock<CommitResult>(input.worktree, async () => {
      const verified = await this.verifyWorktree(input.worktree);
      if (verified.isErr()) return verified;
      const staged = await this.git.run(input.worktree.path, 'stage controlled commit', [
        'add',
        '--all',
      ]);
      if (staged.isErr()) return staged;
      const tree = await this.git.run(input.worktree.path, 'verify controlled commit tree', [
        'write-tree',
      ]);
      if (tree.isErr()) return tree;
      const actualTree = tree.unwrap().stdout.trim();
      if (actualTree !== input.expectedTree) {
        return err(
          toErr(SandboxErrorKind.TreeConflict, {
            runId: input.worktree.runId,
            expected: input.expectedTree,
            received: actualTree,
          }),
        );
      }

      const environment = {
        GIT_AUTHOR_NAME: input.identity.name,
        GIT_AUTHOR_EMAIL: input.identity.email,
        GIT_AUTHOR_DATE: input.timestamp,
        GIT_COMMITTER_NAME: input.identity.name,
        GIT_COMMITTER_EMAIL: input.identity.email,
        GIT_COMMITTER_DATE: input.timestamp,
      };
      const constructed = await this.git.run(
        input.worktree.path,
        'construct controlled commit',
        ['commit-tree', input.expectedTree, '-p', input.expectedHead, '-m', input.message],
        environment,
      );
      if (constructed.isErr()) return constructed;
      const expectedCommit = constructed.unwrap().stdout.trim();
      const head = await this.git.run(input.worktree.path, 'read controlled commit HEAD', [
        'rev-parse',
        'HEAD',
      ]);
      if (head.isErr()) return head;
      const actualHead = head.unwrap().stdout.trim();
      if (actualHead === expectedCommit) {
        return ok({ commit: expectedCommit, recovered: true });
      }
      if (actualHead !== input.expectedHead) {
        return err(
          toErr(SandboxErrorKind.HeadConflict, {
            runId: input.worktree.runId,
            expected: input.expectedHead,
            received: actualHead,
          }),
        );
      }
      const updated = await this.git.run(input.worktree.path, 'advance controlled commit HEAD', [
        'update-ref',
        'HEAD',
        expectedCommit,
        input.expectedHead,
      ]);
      return updated.isErr()
        ? updated
        : ok({
            commit: expectedCommit,
            recovered: false,
          });
    });
  }

  async createDeliveryBranch(
    worktree: RunWorktree,
    branchName: string,
    commit: string,
  ): Promise<Result<void, SandboxError>> {
    const ready = this.validateReady();
    if (ready.isErr()) return ready;
    if (!/^kouro\/[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(branchName)) {
      return err(
        toErr(SandboxErrorKind.WorktreeConflict, {
          runId: worktree.runId,
          path: worktree.path,
          reason: 'delivery branch must use the kouro/<name> namespace',
        }),
      );
    }
    return this.withRepositoryLock(worktree, async () => {
      const verified = await this.verifyWorktree(worktree);
      if (verified.isErr()) return verified;
      const current = await this.git.run(worktree.repositoryPath, 'inspect delivery branch', [
        'rev-parse',
        '--verify',
        '--quiet',
        `refs/heads/${branchName}`,
      ]);
      if (current.isOk()) {
        return current.unwrap().stdout.trim() === commit
          ? ok(undefined)
          : err(
              toErr(SandboxErrorKind.HeadConflict, {
                runId: worktree.runId,
                expected: commit,
                received: current.unwrap().stdout.trim(),
              }),
            );
      }
      const created = await this.git.run(worktree.repositoryPath, 'create delivery branch', [
        'update-ref',
        `refs/heads/${branchName}`,
        commit,
        '0000000000000000000000000000000000000000',
      ]);
      return created.isErr() ? created : ok(undefined);
    });
  }

  async captureArtifacts(worktree: RunWorktree): Promise<Result<WorktreeArtifacts, SandboxError>> {
    const ready = this.validateReady();
    if (ready.isErr()) return ready;
    return this.withRepositoryLock(worktree, async () => {
      const verified = await this.verifyWorktree(worktree);
      if (verified.isErr()) return verified;
      const status = await this.git.run(worktree.path, 'capture Git status', [
        'status',
        '--porcelain=v2',
        '--branch',
      ]);
      if (status.isErr()) return status;
      const captureIndexPath = resolve(
        this.managementRoot,
        'artifacts',
        `.capture-${sha256(worktree.runId)}-${randomUUID()}.index`,
      );
      const captureEnvironment = { GIT_INDEX_FILE: captureIndexPath };
      try {
        const initializedIndex = await this.git.run(
          worktree.path,
          'initialize temporary Git index',
          ['read-tree', 'HEAD'],
          captureEnvironment,
        );
        if (initializedIndex.isErr()) return initializedIndex;
        const stagedChanges = await this.git.run(
          worktree.path,
          'stage changes in temporary Git index',
          ['add', '--all'],
          captureEnvironment,
        );
        if (stagedChanges.isErr()) return stagedChanges;
        const diff = await this.git.run(
          worktree.path,
          'capture Git diff',
          ['diff', '--cached', '--binary', '--no-ext-diff', 'HEAD'],
          captureEnvironment,
        );
        if (diff.isErr()) return diff;
        const statusArtifact = await this.writeArtifact(worktree, 'status', status.unwrap().stdout);
        if (statusArtifact.isErr()) return statusArtifact;
        const diffArtifact = await this.writeArtifact(worktree, 'diff', diff.unwrap().stdout);
        if (diffArtifact.isErr()) return diffArtifact;
        return ok({
          status: statusArtifact.unwrap(),
          diff: diffArtifact.unwrap(),
        });
      } finally {
        await unlink(captureIndexPath).catch(() => undefined);
      }
    });
  }

  async cleanupWorktree(worktree: RunWorktree, force = false): Promise<Result<void, SandboxError>> {
    const ready = this.validateReady();
    if (ready.isErr()) return ready;
    return this.withRepositoryLock(worktree, async () => {
      const pathPresent = await this.pathExists(worktree.path);
      if (pathPresent.isErr()) return pathPresent;
      if (pathPresent.unwrap()) {
        const verified = await this.verifyWorktree(worktree);
        if (verified.isErr()) return verified;
        if (!force) {
          const status = await this.git.run(worktree.path, 'check worktree cleanliness', [
            'status',
            '--porcelain',
          ]);
          if (status.isErr()) return status;
          if (status.unwrap().stdout.length > 0) {
            return err(toErr(SandboxErrorKind.DirtyWorktree, { runId: worktree.runId }));
          }
        }
        const args = force
          ? ['worktree', 'remove', '--force', worktree.path]
          : ['worktree', 'remove', worktree.path];
        const removed = await this.git.run(
          this.repositoryPathFor(worktree),
          'remove run worktree',
          args,
        );
        if (removed.isErr()) return removed;
      } else {
        const pruned = await this.git.run(
          this.repositoryPathFor(worktree),
          'prune missing run worktree',
          ['worktree', 'prune'],
        );
        if (pruned.isErr()) return pruned;
      }
      return this.removeFileIfPresent(
        this.runMetadataPath(worktree.repositoryId, worktree.runId),
        'remove run metadata',
      );
    });
  }

  private validateReady(): Result<void, SandboxError> {
    return this.initialized ? ok(undefined) : err(toErr(SandboxErrorKind.NotInitialized, {}));
  }

  private repositoryMetadataPath(repositoryId: string): string {
    return resolve(this.managementRoot, 'repositories', `${repositoryId}.json`);
  }

  private runMetadataPath(repositoryId: string, runId: string): string {
    return resolve(this.managementRoot, 'runs', repositoryId, `${runId}.json`);
  }

  private worktreePath(repositoryId: string, runId: string): string {
    return resolve(this.managementRoot, 'worktrees', repositoryId, runId);
  }

  private repositoryPathFor(repository: RegisteredRepository): string {
    return repository.repositoryPath;
  }

  private async verifyRegistration(
    repository: RegisteredRepository,
  ): Promise<Result<void, SandboxError>> {
    const identifier = validateIdentifier('repositoryId', repository.repositoryId);
    if (identifier.isErr()) return identifier;
    const metadata = await this.readJson(
      this.repositoryMetadataPath(repository.repositoryId),
      isRegisteredRepository,
    );
    if (metadata.isErr()) return metadata;
    const recorded = metadata.unwrap();
    return recorded?.repositoryPath === repository.repositoryPath &&
      recorded.commonGitDirectory === repository.commonGitDirectory
      ? ok(undefined)
      : err(
          toErr(SandboxErrorKind.RepositoryMismatch, {
            repositoryId: repository.repositoryId,
            expected: recorded?.commonGitDirectory ?? 'registered repository',
            received: repository.commonGitDirectory,
          }),
        );
  }

  private async verifyWorktree(worktree: RunWorktree): Promise<Result<void, SandboxError>> {
    const metadata = await this.readJson(
      this.runMetadataPath(worktree.repositoryId, worktree.runId),
      isRunWorktree,
    );
    if (metadata.isErr()) return metadata;
    const recorded = metadata.unwrap();
    if (!recorded || !sameWorktree(recorded, worktree)) {
      return err(
        toErr(SandboxErrorKind.WorktreeConflict, {
          runId: worktree.runId,
          path: worktree.path,
          reason: 'worktree does not match its durable metadata',
        }),
      );
    }
    return this.reconcileWorktree(worktree);
  }

  private async reconcileWorktree(worktree: RunWorktree): Promise<Result<void, SandboxError>> {
    let common = await this.git.run(worktree.path, 'inspect run worktree', [
      'rev-parse',
      '--git-common-dir',
    ]);
    if (common.isErr()) {
      const repaired = await this.git.run(
        this.repositoryPathFor(worktree),
        'repair interrupted worktree',
        ['worktree', 'repair', worktree.path],
      );
      if (repaired.isErr()) {
        return err(
          toErr(SandboxErrorKind.WorktreeConflict, {
            runId: worktree.runId,
            path: worktree.path,
            reason: 'existing path is not a recoverable Git worktree',
          }),
        );
      }
      common = await this.git.run(worktree.path, 'inspect repaired run worktree', [
        'rev-parse',
        '--git-common-dir',
      ]);
      if (common.isErr()) return common;
    }
    const commonPath = await this.canonicalPath(
      resolve(worktree.path, common.unwrap().stdout.trim()),
      'resolve run common Git directory',
    );
    if (commonPath.isErr()) return commonPath;
    if (commonPath.unwrap() !== worktree.commonGitDirectory) {
      return err(
        toErr(SandboxErrorKind.RepositoryMismatch, {
          repositoryId: worktree.repositoryId,
          expected: worktree.commonGitDirectory,
          received: commonPath.unwrap(),
        }),
      );
    }
    const [head, mergeBase] = await Promise.all([
      this.git.run(worktree.path, 'read recovered worktree HEAD', ['rev-parse', 'HEAD']),
      this.git.run(worktree.path, 'verify recovered worktree history', [
        'merge-base',
        worktree.startingCommit,
        'HEAD',
      ]),
    ]);
    if (head.isErr()) return head;
    if (mergeBase.isErr()) return mergeBase;
    if (mergeBase.unwrap().stdout.trim() !== worktree.startingCommit) {
      return err(
        toErr(SandboxErrorKind.StartingCommitMismatch, {
          runId: worktree.runId,
          startingCommit: worktree.startingCommit,
          head: head.unwrap().stdout.trim(),
        }),
      );
    }
    return ok(undefined);
  }

  private async writeArtifact(
    worktree: RunWorktree,
    kind: GitArtifactKind,
    contents: string,
  ): Promise<Result<GitArtifact, SandboxError>> {
    const path = resolve(
      this.managementRoot,
      'artifacts',
      worktree.repositoryId,
      worktree.runId,
      `${kind}.txt`,
    );
    const written = await this.writeAtomic(path, contents);
    return written.isErr()
      ? written
      : ok({
          kind,
          path,
          checksum: sha256(contents),
          size: Buffer.byteLength(contents),
        });
  }

  private async withRepositoryLock<T>(
    repository: RegisteredRepository,
    operation: () => Promise<Result<T, SandboxError>>,
  ): Promise<Result<T, SandboxError>> {
    const acquired = await this.acquireLock(repository);
    if (acquired.isErr()) return acquired;
    const lock = acquired.unwrap();
    let result: Result<T, SandboxError>;
    try {
      result = await operation();
    } catch (error) {
      await this.releaseLock(lock);
      throw error;
    }
    const released = await this.releaseLock(lock);
    if (released.isErr()) {
      return released;
    }
    return result;
  }

  private async acquireLock(
    repository: RegisteredRepository,
  ): Promise<Result<AcquiredLock, SandboxError>> {
    const path = resolve(
      this.managementRoot,
      'locks',
      `${sha256(repository.commonGitDirectory)}.lock`,
    );
    const deadline = Date.now() + this.lockTimeoutMs;
    while (Date.now() <= deadline) {
      const token = randomUUID();
      const record: LockRecord = { processId: process.pid, token };
      const created = await fromAsync(
        async () => {
          let ownsPath = false;
          try {
            const handle = await open(path, 'wx');
            ownsPath = true;
            try {
              await handle.writeFile(JSON.stringify(record));
            } finally {
              await handle.close();
            }
          } catch (error) {
            if (ownsPath) await unlink(path).catch(() => undefined);
            throw error;
          }
        },
        (error) => filesystemError('acquire repository lock', error),
      );
      if (created.isOk()) return ok({ ...record, path });
      if (filesystemCode(created.error) !== 'EEXIST') return created;
      const reclaimed = await this.reclaimStaleLock(path);
      if (reclaimed.isErr()) return reclaimed;
      if (!reclaimed.unwrap()) await delay(this.lockRetryMs);
    }
    return err(
      toErr(SandboxErrorKind.LockTimeout, {
        repositoryId: repository.repositoryId,
      }),
    );
  }

  private async reclaimStaleLock(path: string): Promise<Result<boolean, SandboxError>> {
    const text = await fromAsync(
      () => readFile(path, 'utf8'),
      (error) => filesystemError('read repository lock', error),
    );
    if (text.isErr()) {
      return filesystemCode(text.error) === 'ENOENT' ? ok(true) : text;
    }
    const parsed = safeCall(
      () => JSON.parse(text.unwrap()) as unknown,
      () => toErr(SandboxErrorKind.CorruptMetadata, { path }),
    );
    const record = parsed.isOk() ? parsed.unwrap() : null;
    if (isLockRecord(record) && this.processExists(record.processId)) {
      return ok(false);
    }
    if (!isLockRecord(record)) {
      const inspected = await fromAsync(
        () => stat(path),
        (error) => filesystemError('inspect repository lock', error),
      );
      if (inspected.isErr()) {
        return filesystemCode(inspected.error) === 'ENOENT' ? ok(true) : inspected;
      }
      if (Date.now() - inspected.unwrap().mtimeMs <= this.lockTimeoutMs) {
        return ok(false);
      }
    }
    const removed = await this.removeFileIfPresent(path, 'reclaim repository lock');
    return removed.isErr() ? removed : ok(true);
  }

  private processExists(processId: number): boolean {
    try {
      process.kill(processId, 0);
      return true;
    } catch (error) {
      return errorCode(error) !== 'ESRCH';
    }
  }

  private async releaseLock(lock: AcquiredLock): Promise<Result<void, SandboxError>> {
    const text = await fromAsync(
      () => readFile(lock.path, 'utf8'),
      (error) => filesystemError('read owned repository lock', error),
    );
    if (text.isErr()) {
      return filesystemCode(text.error) === 'ENOENT' ? ok(undefined) : text;
    }
    const parsed = safeCall(
      () => JSON.parse(text.unwrap()) as unknown,
      () => toErr(SandboxErrorKind.CorruptMetadata, { path: lock.path }),
    );
    if (parsed.isErr()) return parsed;
    const record = parsed.unwrap();
    if (!isLockRecord(record) || record.token !== lock.token) {
      return err(toErr(SandboxErrorKind.CorruptMetadata, { path: lock.path }));
    }
    return this.removeFileIfPresent(lock.path, 'release repository lock');
  }

  private async canonicalPath(
    path: string,
    operation: string,
  ): Promise<Result<string, SandboxError>> {
    return fromAsync(
      () => realpath(path),
      (error) => filesystemError(operation, error),
    );
  }

  private async createDirectory(path: string): Promise<Result<void, SandboxError>> {
    return fromAsync(
      async () => {
        await mkdir(path, { recursive: true });
      },
      (error) => filesystemError('create directory', error),
    );
  }

  private async pathExists(path: string): Promise<Result<boolean, SandboxError>> {
    const inspected = await fromAsync(
      () => stat(path),
      (error) => filesystemError('inspect path', error),
    );
    if (inspected.isOk()) return ok(true);
    return filesystemCode(inspected.error) === 'ENOENT' ? ok(false) : inspected;
  }

  private async readJson<T>(
    path: string,
    validate: (value: unknown) => value is T,
  ): Promise<Result<T | null, SandboxError>> {
    const text = await fromAsync(
      () => readFile(path, 'utf8'),
      (error) => filesystemError('read metadata', error),
    );
    if (text.isErr()) {
      return filesystemCode(text.error) === 'ENOENT' ? ok(null) : text;
    }
    const parsed = safeCall(
      () => JSON.parse(text.unwrap()) as unknown,
      () => toErr(SandboxErrorKind.CorruptMetadata, { path }),
    );
    if (parsed.isErr()) return parsed;
    const value = parsed.unwrap();
    return validate(value) ? ok(value) : err(toErr(SandboxErrorKind.CorruptMetadata, { path }));
  }

  private async writeJsonAtomic(
    path: string,
    value: RegisteredRepository | RunWorktree,
  ): Promise<Result<void, SandboxError>> {
    return this.writeAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
  }

  private async writeAtomic(path: string, contents: string): Promise<Result<void, SandboxError>> {
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    return fromAsync(
      async () => {
        await mkdir(dirname(path), { recursive: true });
        try {
          await writeFile(temporaryPath, contents, { flag: 'wx' });
          await rename(temporaryPath, path);
        } catch (error) {
          await unlink(temporaryPath).catch(() => undefined);
          throw error;
        }
      },
      (error) => filesystemError('write atomic file', error),
    );
  }

  private async removeFileIfPresent(
    path: string,
    operation: string,
  ): Promise<Result<void, SandboxError>> {
    const removed = await fromAsync(
      () => unlink(path),
      (error) => filesystemError(operation, error),
    );
    return removed.isErr() && filesystemCode(removed.error) === 'ENOENT' ? ok(undefined) : removed;
  }
}
