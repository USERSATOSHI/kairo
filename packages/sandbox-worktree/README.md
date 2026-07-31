# `@kouro/sandbox-worktree` — Isolated Git Worktree Manager

Infrastructure adapter for managing **isolated, disposable Git worktrees** as execution sandboxes for Kouro workflow runs. Provides deterministic, recoverable operations on top of Git repositories — registration, commit pinning, worktree creation, controlled commits, artifact capture, and cleanup.

The package also owns provider-tool isolation infrastructure. `WorktreePathGuard`
contains direct file tools inside an exact worktree, while
`SandboxRuntimeAgentCommandSandbox` runs agent-controlled commands through a
short-lived cross-platform helper. The helper uses Seatbelt on macOS,
Bubblewrap on Linux/WSL2, and a provisioned account plus ACL/WFP enforcement on
native Windows. Unavailable isolation fails closed.

## Architecture

```
WorktreeSandboxProvider
  ├── GitCommandRunner — wraps git CLI via Bun.spawn
  ├── Filesystem operations — atomic writes, locks, metadata
  └── Lock system — per-repository filesystem locks

Agent tool isolation
  ├── WorktreePathGuard — lexical, canonical, and symlink containment
  └── SandboxRuntimeAgentCommandSandbox
      └── one Sandbox Runtime helper process per command
```

## Usage

### Lifecycle

```typescript
import { WorktreeSandboxProvider } from '@kouro/sandbox-worktree';

const sandbox = new WorktreeSandboxProvider('/path/to/management/root');

// 1. Initialize — creates directory structure
await sandbox.initialize();

// 2. Register a repository
const repo = await sandbox.registerRepository('my-repo', '/path/to/repo');
// Returns: { repositoryId, repositoryPath, commonGitDirectory }

// 3. Pin a specific commit
const pinned = await sandbox.pinStartingCommit(repo, 'main');
// Returns: { ...repo, startingCommit: 'abc123...' }

const base = await sandbox.resolveBaseBranch(pinned, 'main');
// Verifies that the named base resolves to the pinned starting commit.

// 4. Create a worktree sandbox for a run
const worktree = await sandbox.createWorktree(pinned, 'run-abc');
// Returns: { repositoryId, runId, repositoryPath, path, commonGitDirectory, startingCommit }

// 5. (Run does its work in the worktree path)

// 6. Capture artifacts (git status + git diff)
const artifacts = await sandbox.captureArtifacts(worktree);
// Returns: { status: GitArtifact, diff: GitArtifact }

// 7. Prepare a commit (stage all, write tree)
const prepared = await sandbox.prepareCommit(worktree);
// Returns: { head: 'abc...', tree: 'def...' }

// 8. Commit with full control
const commitResult = await sandbox.commitWorktree({
  worktree,
  expectedHead: prepared.head,
  expectedTree: prepared.tree,
  message: 'Workflow output',
  identity: { name: 'Kouro', email: 'kouro@example.com' },
  timestamp: '2026-07-26T12:00:00.000Z',
});
// Returns: { commit: 'ghi...', recovered: false }

// 9. Create delivery branch (kouro/ namespace)
await sandbox.createDeliveryBranch(worktree, 'kouro/run-abc', commitResult.commit);

// Push without force; an existing remote branch must name the same commit.
await sandbox.pushDeliveryBranch(
  worktree,
  'origin',
  'kouro/run-abc',
  commitResult.commit,
);

// 10. Clean up the worktree
await sandbox.cleanupWorktree(worktree);
```

## Storage Layout

All data lives under the `managementRoot`:

```
<managementRoot>/
  repositories/           — JSON metadata per registered repo
    <repoId>.json
  runs/                   — JSON metadata per run per repo
    <repoId>/
      <runId>.json
  worktrees/              — Actual Git worktrees
    <repoId>/
      <runId>/            — Detached worktree at pinned commit
  artifacts/              — Captured status/diff files
    <repoId>/
      <runId>/
        status.txt
        diff.txt
  locks/                  — Per-repository lock files
    <sha256(commonGitDir)>.lock
```

## Key Operations

### `registerRepository(repositoryId, repositoryPath)`

- Canonicalizes the path (resolves symlinks, relative paths)
- Resolves Git top-level and common Git directory
- Stores a `RegisteredRepository` JSON file
- Uses per-repo lock for atomicity
- Fails with `RegistrationConflict` if the same ID is registered with different paths

### `pinStartingCommit(repository, reference?)`

- Resolves `ref^{commit}` (default: `HEAD`)
- Returns a `PinnedRepository` with the immutable starting commit hash
- Fails if the reference cannot be resolved

### `createWorktree(repository, runId)`

- Creates a Git worktree via `git worktree add --detach` at the pinned commit
- Records metadata in `runs/<repoId>/<runId>.json`
- If the path already exists, attempts **reconciliation** (recovery):
  - Runs `git worktree repair` if the worktree appears broken
  - Verifies common Git directory matches
  - Verifies merge-base of startingCommit and HEAD is exactly startingCommit

### `prepareCommit(worktree)`

- Stages all changes: `git add --all`
- Reads HEAD: `git rev-parse HEAD`
- Writes a tree object: `git write-tree`
- Returns `{ head, tree }` — does NOT create a commit

### `commitWorktree(input)`

The **fully controlled commit** operation:

1. Validates the timestamp is canonical ISO-8601
2. Stages changes and writes tree (same as `prepareCommit`)
3. Verifies the computed tree matches `expectedTree` — fails with `TreeConflict` if not
4. Constructs a commit with `git commit-tree` using exact identity, timestamp, message, tree, and parent
5. If worktree HEAD already equals the computed commit hash → `{ recovered: true }`
6. Otherwise verifies HEAD matches `expectedHead` → `HeadConflict` if not
7. Updates HEAD with `git update-ref`
8. Returns `{ commit: <hash>, recovered: bool }`

**Deterministic and idempotent**: Retrying the same inputs produces the same commit hash.

### `captureArtifacts(worktree)`

- Runs `git status --porcelain=v2 --branch`
- Stages the complete worktree in a temporary index without changing the real index
- Runs `git diff --cached --binary --no-ext-diff HEAD` so new files are included
- Writes both to files under `artifacts/<repoId>/<runId>/`
- Returns paths, SHA-256 checksums, and sizes as `GitArtifact`

### `createDeliveryBranch(worktree, branchName, commit)`

- Creates a branch in the `kouro/<name>` namespace
- If branch exists at same commit → no-op
- If branch exists at different commit → `HeadConflict`

### `cleanupWorktree(worktree, force?)`

- Default: checks worktree is clean (`git status --porcelain` empty), then removes with `git worktree remove`
- If `force`: uses `--force` even with uncommitted changes
- If path is already gone: prunes worktree metadata
- Removes run metadata JSON

## Concurrency Model

Per-repository filesystem locks under `locks/`:

- Lock file named `<sha256(commonGitDirectory)>.lock`
- Acquired with `open(path, 'wx')` (exclusive create)
- Contains `{ processId, token }` (UUID)
- **Stale lock reclamation**: If owning process no longer exists, or file is older than `lockTimeoutMs` and corrupt/missing process, the lock is deleted and retried
- Configuration: `lockTimeoutMs` (default 10s), `lockRetryMs` (default 20ms)

## Error Handling

| Error Kind | Code | Meaning |
|------------|------|---------|
| `NotInitialized` | 0 | Provider used before `initialize()` |
| `InvalidIdentifier` | 1 | repositoryId/runId fails pattern `/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/` |
| `GitFailure` | 2 | Git subprocess failed |
| `FilesystemFailure` | 3 | OS file operation error |
| `RegistrationConflict` | 4 | Re-registering with different paths |
| `RepositoryMismatch` | 5 | Recorded metadata doesn't match |
| `StartingCommitMismatch` | 6 | Worktree HEAD diverged from pinned commit |
| `WorktreeConflict` | 7 | Worktree state incompatible |
| `DirtyWorktree` | 8 | Uncommitted changes during cleanup |
| `HeadConflict` | 9 | HEAD doesn't match expected value |
| `TreeConflict` | 10 | Tree doesn't match expected value |
| `LockTimeout` | 11 | Could not acquire repository lock |
| `CorruptMetadata` | 12 | JSON metadata unparseable |

## Exported API

| Export | Kind | Source |
|--------|------|--------|
| `WorktreeSandboxProvider` | class | `worktree-sandbox-provider.ts` |
| `WorktreeSandboxOptions` | interface | `worktree-sandbox-provider.ts` |
| `GitCommandRunner` | class | `git-command-runner.ts` |
| `GitCommandOutput` | interface | `git-command-runner.ts` |
| `SandboxErrorKind` | const enum | `errors.ts` |
| `SandboxError` | type | `errors.ts` |
| `WorktreePathGuard` | class | `worktree-path-guard.ts` |
| `AgentCommandSandbox` | interface | `agent-command-sandbox.ts` |
| `SandboxRuntimeAgentCommandSandbox` | class | `agent-command-sandbox.ts` |
| `AgentCommandSandboxAvailability` | interface | `agent-command-sandbox.ts` |
| `RegisteredRepository` | interface | `types.ts` |
| `PinnedRepository` | interface | `types.ts` |
| `RunWorktree` | interface | `types.ts` |
| `PreparedCommit` | interface | `types.ts` |
| `CommitResult` | interface | `types.ts` |
| `CommitWorktreeInput` | interface | `types.ts` |
| `CommitIdentity` | interface | `types.ts` |
| `GitArtifact` | interface | `types.ts` |
| `GitArtifactKind` | type | `types.ts` |
| `WorktreeArtifacts` | interface | `types.ts` |

## Dependencies

| Package | Purpose |
|---------|---------|
| `@anthropic-ai/sandbox-runtime` | Cross-platform command isolation adapter |
| `@usersatoshi/results` | `Result<T, E>` type |

No other Kouro dependencies — this is a standalone infrastructure package.
