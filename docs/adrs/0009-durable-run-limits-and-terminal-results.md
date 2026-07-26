# ADR-0009: Run limits and terminal results are deterministic workflow data

- Status: Accepted
- Date: 2026-07-26

## Context

The feature-development workflow must stop after eight hours or thirty node
invocations, and exhausted repair paths must fail rather than enter a successful
completion node. A scheduler clock read or an executor-specific invocation
counter would make those decisions depend on hidden process state.

## Decision

Compiled workflows may declare `maxDurationMs` and `maxNodeInvocations`.
Creation records the run start time. Before scheduling, the application records
the current observed time as an event; the pure scheduler compares only
projected timestamps and compiled limits.

Completion nodes declare either `succeeded` or `failed`, defaulting to
`succeeded` for compatibility. The scheduler emits the declared terminal
result.

The node-invocation limit is checked only when a new graph activation would be
created. Existing invocations may finish, approvals may be decided, and
attempt-level recovery does not consume the graph limit.

## Failure behavior

- Invalid or decreasing observed timestamps are rejected as typed runtime
  history failures.
- Reaching the duration limit schedules a failed run completion.
- A transition that would create invocation `limit + 1` schedules a failed run
  completion instead.
- Exhausted repair transitions target a failed completion node.

## Alternatives considered

- Reading the clock in `scheduleRun` violates event-history determinism.
- Treating an operational retry as a node invocation conflates attempts with
  graph traversal.
- Routing exhausted repairs to an ordinary completion node incorrectly reports
  success.
