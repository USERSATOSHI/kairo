# ADR-0021 — Ticket integration uses commands, durable operations, and projections

- Status: Accepted
- Date: 2026-07-26

## Context

T1 established local tickets as mutable planning aggregates beside Kairo's
runtime. T2 through T6 connect those tickets to runs and external providers
without weakening immutable run inputs or runtime ownership.

## Decision

- Starting a ticket run captures a `TicketSnapshot`, invokes the existing
  run-start application boundary, and then records a `TicketRunLink`.
- Active implementation-run uniqueness is checked through a run-query port.
  ADWs may explicitly opt into parallel variants.
- Board execution columns are projections of run state and are never stored as
  mutable ticket status.
- Active-run ticket changes produce application commands according to a pure
  policy. Ticket code never appends runtime events directly.
- GitHub and Forgejo implement a provider-neutral ticket contract.
- Provider writes and webhook deliveries use durable idempotency records.
- Webhooks are authenticated before their payload is parsed or persisted.
- Polling uses the same normalization and reconciliation path as webhooks.
- Local-to-remote migration is a durable sequence of individually recoverable
  steps. Authority switches only after the created issue is read back and
  verified.
- Provider credentials and webhook secrets are supplied by secret-resolving
  composition code and are never persisted in ticket rows or operation
  payloads.

## Consequences

- Provider failure cannot change a completed run result.
- Missed webhook events can be repaired by polling.
- Interrupted migration resumes from its last durable completed step.
- The HTTP and web layers invoke ticket application services and do not own
  ticket or run semantics.
