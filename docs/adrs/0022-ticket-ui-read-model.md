# ADR-0022 — Ticket UI consumes composed read models

- Status: Accepted
- Date: 2026-07-26

## Context

T1 through T5 established mutable planning tickets, immutable run snapshots,
derived execution columns, provider synchronization, and resumable migration.
Those records are durable, but operators cannot inspect them together through
the local HTTP and web surfaces.

The UI must not infer orchestration semantics from raw runtime events, persist
derived execution columns, or receive provider credentials. It also must not
make ticket persistence part of the deterministic runtime.

## Decision

Add a ticket read boundary to the existing API composition:

```text
React ticket console
    ↓
Elysia ticket routes
    ↓
Ticket read use cases
    ↓
Ticket, run-link, sync-history, and runtime-query ports
```

The read use cases join mutable ticket records with:

- the pure `deriveTicketBoardColumn` projection;
- run links and immutable snapshots;
- runtime-owned execution-column views;
- synchronization state and operation history;
- durable migration checkpoints.

SQLite records one migration-history row per completed stage while retaining
the existing current-migration projection. This is additive and makes the
operator-visible recovery sequence explicit.

Provider configuration is supplied by composition as a redacted view. The
browser can see whether a provider is configured and its non-secret endpoint or
repository scope, but tokens and webhook secrets remain server-resolved and
are never persisted or returned.

## Consequences

- planning and execution state appear on one Kanban without duplicating runtime
  state in ticket rows;
- ticket details expose run, snapshot, sync, and migration history through
  transport DTOs;
- the local composition initializes ticket stores beside the existing run
  store while preserving their bounded-domain APIs;
- an unconfigured remote provider can be explained safely in the UI;
- ticket mutation, synchronization triggers, migration commands, and browser
  credential entry remain separate command-surface work.

## Alternatives considered

Deriving execution columns in React was rejected because browser heuristics
would duplicate application semantics. Persisting execution columns on tickets
was rejected because they are runtime-owned projections. Sending tokens from a
configuration form was rejected because the accepted provider boundary keeps
credentials in secret-resolving composition.
