# ADR-0006: Commit events and projections atomically

- Status: Accepted
- Date: 2026-07-26

## Context

M2 adds durable orchestration to the pure M1 runtime. A process may receive the
same intent more than once, and it may stop between an external command and the
event that records its result. Query projections must never describe state that
cannot be reconstructed from the append-only history.

## Decision

Each run owns a contiguous event sequence starting at one. A store commit:

1. requires the caller's expected next sequence;
2. binds a stable idempotency key to the canonical event request;
3. reduces the complete candidate history with the pinned workflow;
4. appends the event and replaces affected projections in one SQLite
   transaction.

Reusing an idempotency key with the same request returns the original committed
event. Reusing it with a different request is a typed conflict. A sequence
mismatch is also a typed conflict and is never silently retried.

The SQLite adapter persists the exact compiled workflow bundle with the run.
On restart, active attempts are recorded as interrupted before the pure
scheduler selects the declared recovery action. This records the
nondeterministic observation instead of hiding it in coordinator state.

Command completion is not claimed to be exactly once. Its snapshotted recovery
policy determines whether replay is allowed after an interruption.

## Transaction boundary

```text
expected sequence + idempotency key + event request
                         ↓
             validate candidate history
                         ↓
       append event + replace projections
                  one transaction
```

## Failure behavior

- A missing run, sequence race, idempotency conflict, invalid event, corrupt
  persisted value, or SQLite failure is returned as a typed store error.
- Duplicate event sequences are rejected by both the expected-sequence check
  and the database primary key.
- A failed reduction writes neither the event nor projections.

## Counterexample

Updating an invocation projection and committing its event in separate
transactions can leave a completed invocation with no durable completion fact
after a crash. Replaying that database would produce a different state.

## Executable acceptance scenarios

1. Command → approval → command → complete continues after closing and
   reopening the database.
2. A requested approval remains pending after reopening the database.
3. Recommitting the same idempotent request does not create another event or
   invocation.
4. A different request with a reused idempotency key is rejected.
5. Two commits claiming the same next sequence cannot both succeed.
6. Restart recovery records an active attempt as interrupted before replaying
   a `replay_safe` command.
