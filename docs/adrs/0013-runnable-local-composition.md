# ADR-0013 — Runnable local composition

- Status: Accepted
- Date: 2026-07-26

## Context

M1–M6 expose tested components, but operators need one executable composition.

## Decision

`@kouro/cli` is the application composition boundary. It owns predictable local
paths, initializes SQLite and worktree storage, compiles packaged or local ADWs,
registers and pins repositories, creates run worktrees, constructs per-run
coordinators, runs the local worker, and hosts the Elysia API with built web
assets.

Decision-affecting inputs—including ADW identity, harness order, repository and
worktree identity, requested permissions, delivery branch, and operator—are
snapshotted in `run.created.configuration`.

## Consequences

- Domain and runtime remain independent of Bun CLI, Elysia, Git, and filesystem
  APIs.
- CLI and HTTP invoke the same application host.
- The built-in feature workflow is packaged source and compiled into an exact
  content-addressed bundle at run creation.
- Separate remote workers, PostgreSQL, deployment, and automatic merge remain
  deferred.
