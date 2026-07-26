# ADR-0001: Event-history-based determinism

- Status: Accepted
- Date: 2026-07-26

## Context

External programs and coding agents are not reproducible. Defining Kairo as
deterministic only from workflow inputs and repository state would promise
control over effects Kairo does not own.

## Decision

Kairo's deterministic boundary is:

> Given the same compiled workflow and ordered durable event history, Kairo
> reconstructs the same state and emits the same next orchestration decisions.

The compiled bundle contains every static decision input. Events contain every
nondeterministic observation accepted during execution. Projection and
scheduling are pure functions.

The scheduler emits intents without generated identifiers, current timestamps,
leases, or event sequence numbers. Infrastructure assigns those values while
durably committing an intent.

## Serialized representation

```ts
interface RuntimeInput {
	workflow: CompiledWorkflow;
	events: readonly RunEvent[];
}

interface RuntimeOutput {
	state: RunState;
	intents: readonly OrchestrationIntent[];
}
```

Both values must have canonical, serializable representations.

## Failure behavior

Malformed or non-contiguous history returns a typed reducer failure. A
programming defect inside a pure runtime function may throw.

## Counterexample

A scheduler calling `Date.now()` to decide whether a run has timed out can
produce different decisions from the same event history. Instead, an observed
time must enter history as an event before timeout evaluation.

## Executable acceptance scenarios

1. Replaying the same bundle and events repeatedly produces byte-identical state
   and intents.
2. Recreating objects with different property insertion order does not change
   canonical output.
3. Duplicate, missing, or reordered event sequences return typed failures.
