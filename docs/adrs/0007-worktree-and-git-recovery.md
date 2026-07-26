# ADR-0007: Worktrees use deterministic identity and verified Git mutations

- Status: Accepted
- Date: 2026-07-26

## Context

Kairo runs may modify the same registered repository concurrently. A process can
also stop after Git creates a worktree or commit but before Kairo records the
result. Retrying either operation without observing Git state can conflict with
another run or duplicate a commit.

Git worktrees isolate working files, but their administrative metadata and refs
remain shared by the repository. Those shared mutations require coordination.

## Decision

Repository registration records the canonical repository root and common Git
directory. A run separately pins an input ref to a full commit ID before
execution.

Each `(repository ID, run ID)` pair maps to one deterministic worktree path.
Creation is a reconcile operation:

1. reuse the path when it belongs to the registered common Git directory and
   its history contains the pinned starting commit;
2. create a detached worktree at the pinned commit when no worktree exists;
3. reject an existing path that cannot prove both properties.

Shared repository mutations acquire a filesystem lock scoped to the canonical
common Git directory. Lock records include process identity and can be reclaimed
when their owner no longer exists.

Commit preparation stages the complete worktree and returns its exact tree ID.
A controlled commit requires an expected parent HEAD, expected tree, message,
author, and timestamp. These inputs make the commit object reproducible.
Recovery reconstructs the expected commit and:

- advances `HEAD` with a compare-and-swap when it still names the expected
  parent;
- returns the existing commit when `HEAD` already names that exact commit;
- rejects any other HEAD or tree.

Status and binary diff artifacts are written through a temporary file, hashed,
atomically renamed, and then returned as checksum-bearing references.

Cleanup refuses dirty worktrees unless the caller explicitly authorizes forced
removal.

## Consequences

- Concurrent runs use isolated working directories while repository-wide Git
  administration is serialized.
- An interrupted worktree creation can be retried without creating a second
  worktree.
- An interrupted commit can be verified without creating a second commit.
- Callers must durably record the pinned commit and the prepared tree before
  relying on recovery.
- Worktrees provide change isolation, not a security boundary.

## Alternatives considered

- In-process mutexes do not coordinate separate workers or survive restarts.
- Random worktree paths make interrupted creation difficult to discover.
- `git commit` without fixed identity and time cannot reproduce the expected
  commit object during verification.
- Automatically deleting an unverified existing directory risks destroying
  unrelated user data.
