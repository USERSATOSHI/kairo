# ADR-0011 — Durable lifecycle controls

- Status: Accepted
- Date: 2026-07-26

## Context

Operators need to pause, resume, cancel, interrupt, retry, and skip runs from
both the CLI and HTTP surfaces. These actions affect recovery and scheduling,
so transient process flags are insufficient.

## Decision

Every lifecycle action is an append-only run event carrying the durable actor
and, where the action changes an invocation outcome, a reason. Pause prevents
new scheduling but does not terminate an active effect. Interrupt changes the
active attempt to interrupted and remains distinct from pause. Explicit retry
is accepted only for an interrupted `replay_safe` operation.

Skip is workflow policy, not administrative override. A node may declare one
`skipOutcome`. A skip event binds the workflow checksum, invocation, selected
outcome, all published artifact checksums, repository HEAD, actor, and reason.
The reducer rejects a stale or ineligible skip.

## Consequences

- Replaying history reconstructs lifecycle state without process-local flags.
- CLI and web controls observe one state.
- Cancellation is terminal.
- Pause is graceful; interrupt is an explicit recovery fact.
- Existing workflows without `skipOutcome` cannot be skipped.
