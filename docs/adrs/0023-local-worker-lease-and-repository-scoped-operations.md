# ADR-0023 — Local worker lease and repository-scoped operations

- Status: Accepted
- Date: 2026-07-27
- Supersedes: the process-only ownership constraint in ADR-0012

## Context

The local CLI and `kouro serve` open the same durable data directory. Startup
recovery previously ran before either process established execution ownership.
Starting the dashboard while `kouro run` was executing could therefore record
the active attempt as interrupted and leave the run without an executor.

The shared local database also contains runs from every registered repository.
A server started for one repository must not expose another repository's runs
through list or direct run endpoints.

Operators also need to remove obsolete local runs. Cancellation is a durable
lifecycle fact, not deletion, and does not reclaim Kouro-owned worktrees,
artifacts, events, or projections.

## Decision

### Durable local worker ownership

SQLite stores one renewable local-worker lease. A worker must acquire the lease
before startup recovery or orchestration. The lease has an opaque owner ID and
an expiry supplied by the infrastructure clock.

- A lease owner renews while a harness or command is active.
- A second process may serve read APIs while another process owns execution.
- A non-owner periodically retries acquisition and takes over after release or
  expiry.
- Recovery runs once after acquisition, never merely because a process opened
  the database.
- Disposal releases a lease only when the caller still owns it.

Lease mutation is infrastructure coordination. It does not enter workflow
history and cannot affect pure orchestration decisions.

### Repository-scoped server

`kouro serve` is scoped to `--repo <path>`, defaulting to the current working
directory. The application receives a repository-scoped run store, so list and
direct run reads return only runs whose snapshotted `repositoryId` matches the
server scope. Lifecycle, approval, artifact, event, workflow, and deletion
operations first resolve the run through that scoped store.

An explicit `--all-repos` operator option may expose the shared local view. The
default remains repository-scoped.

### Terminal-run deletion

Deletion is an explicit destructive operator action distinct from cancellation.
Only `succeeded`, `failed`, or `cancelled` runs may be deleted. Active, paused,
created, and approval-waiting runs must first reach a terminal state.

Deletion removes:

- the Kouro-owned run worktree and its run metadata;
- the Kouro-owned artifact directory;
- the run row, append-only events, idempotency records, and projections through
  one SQLite transaction.

The source repository and any delivery branch are intentionally preserved.
Filesystem cleanup happens before the database transaction and is replay-safe.
If cleanup or database deletion fails, the durable run remains visible and the
operator can retry. The API and CLI require an explicit delete action, and the
web UI requires confirmation.

## Alternatives considered

### Make `serve` read-only

This would allow observation while a CLI process is alive, but it would not
provide safe ownership handoff after the CLI exits or crashes.

### Use only a process-local mutex

A mutex cannot coordinate two CLI processes and is the cause of the existing
failure mode.

### Filter runs only in React

Client filtering still exposes other repositories through the API and direct
run URLs, so repository scope belongs at the application boundary.

### Represent deletion as another run event

An event cannot erase its own history or reclaim external artifacts. Deletion
is a local retention operation outside deterministic workflow replay.

## Consequences

- `kouro run` and `kouro serve` can use one data directory concurrently while
  exactly one local worker advances runs.
- Starting the dashboard cannot interrupt an active attempt.
- A repository-scoped server does not reveal run IDs, events, artifacts, or
  controls from another repository.
- Stale worker takeover is bounded by the lease duration.
- Run deletion deliberately removes audit history and therefore remains
  terminal-only and explicit.
- Distributed workers, per-run leases, and remote queues remain deferred.
