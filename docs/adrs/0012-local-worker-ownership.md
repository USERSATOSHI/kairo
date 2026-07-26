# ADR-0012 — Local worker ownership

- Status: Accepted
- Date: 2026-07-26

## Context

The local MVP needs background progress and startup recovery without
introducing leases or a distributed queue.

## Decision

One `LocalWorker` instance owns advancement inside the single Kairo process.
It serially scans durable non-terminal runs, records active attempts as
interrupted during startup recovery, and advances each run until it reaches a
stable boundary: approval, pause, terminal state, or reconciliation.

The worker has explicit `start()` and `dispose()` lifecycle methods. A
process-local reentrancy guard prevents overlapping scans. Cross-process worker
leases remain deferred.

## Consequences

- Completed events and Git identities remain idempotent across restart.
- The MVP is intentionally single-process.
- Running two independent `kairo serve` processes against one data directory is
  unsupported until durable leases exist.
