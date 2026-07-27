# ADR-0024 — Live invocation activity is an ephemeral observation

- Status: Accepted
- Date: 2026-07-27

## Context

Operators can inspect a durable harness transcript after an agent attempt
finishes, but they cannot see what an active agent is doing. The local worker
and HTTP server may run in different processes, so an in-memory observer would
not reliably connect them. Publishing every partial harness message as a run
event would also mix provider-specific presentation data into the deterministic
event history.

Completed transcripts are JSON or JSONL in provider-specific formats. Raw
presentation makes conversations, reasoning summaries, and concurrent tool
calls difficult to follow, especially when tool results complete in a different
order than calls were started.

## Decision

Harness process stdout may be copied to a best-effort, file-backed invocation
activity record while execution is in progress. The record is scoped by run,
invocation, and attempt and contains the exact prompt metadata, harness identity,
raw transcript bytes, and a completion marker.

The activity record is an observation only:

- it is not appended to the durable run event stream;
- reducers, schedulers, recovery, approvals, and agent output validation never
  read it;
- write failures do not fail or alter the agent attempt;
- the completed, checksum-verified harness transcript artifact remains the
  durable authority;
- deleting a run removes its activity records with the Kouro-owned artifact
  tree.

The application API validates the requested run and invocation through the
observable run store before reading activity through a declared port. The React
console polls only active invocations and presents both live activity and
completed transcript artifacts through the same provider-neutral timeline.
Tool calls and results are correlated by provider call IDs rather than arrival
order.

## Consequences

- A serving process can observe a worker-owned attempt through their shared
  local data directory.
- Live activity can be incomplete after a crash and is explicitly not a
  recovery input.
- Providers that emit incremental JSONL show progress immediately; providers
  that emit one final JSON object become visible only when that object is
  written.
- Provider transcript formats remain outside the deterministic domain and are
  normalized only for presentation.

## Alternatives considered

Persisting partial messages as run events was rejected because it makes
provider output timing part of durable orchestration history. An in-memory event
bus was rejected because worker ownership and HTTP serving can reside in
different processes. Rewriting the durable transcript incrementally was
rejected because artifacts must be written and checksum-verified atomically
before publication.
