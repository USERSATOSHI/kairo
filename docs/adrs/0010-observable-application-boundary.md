# ADR-0010: Observable state is exposed through application use cases

- Status: Accepted
- Date: 2026-07-26

## Context

The web MVP must explain a run, replay its event history, display artifacts, and
complete approvals without allowing transport or browser code to become an
orchestration authority. Reconnecting clients also need an unambiguous cursor
over append-only history.

## Decision

Elysia handlers validate transport input, invoke one application use case, and
map the typed result to HTTP. Read use cases consume an `ObservableRunStore`
port. Approval decisions resolve the pending binding from durable state and
delegate to `RunCoordinator`; clients never submit their own binding.

The event endpoint uses the durable event sequence as its server-sent-event ID.
It replays only events with sequence greater than the maximum of the `after`
query cursor and `Last-Event-ID` header. Event names and data use the shared
transport-neutral API contracts.

Artifact metadata comes from durable projections. Content is accessed through
an injected reader that verifies size and checksum before returning bytes.

The React dashboard is a consumer of these contracts. Its graph is read-only;
it can request approval decisions but cannot schedule nodes, mutate the graph,
or alter workflow limits.

## Failure behavior

- Missing resources produce typed not-found responses.
- Invalid replay cursors and approval inputs produce typed input failures.
- A decision against a non-pending approval is rejected as a conflict.
- Persistence and artifact verification failures do not expose internal causes.

## Alternatives considered

- Querying SQLite directly from Elysia handlers couples transport to schema and
  bypasses the application boundary.
- Accepting approval bindings from the browser permits stale or substituted
  bindings.
- Replaying by timestamps is ambiguous; durable event sequences are ordered and
  already part of the determinism model.
- Allowing React Flow edits would make the UI an undeclared workflow-authoring
  and scheduling authority.
