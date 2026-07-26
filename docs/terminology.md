# Kairo Runtime Terminology

This document defines the terms used by the runtime contract. These definitions
are normative for M1.

## Workflow terms

### ADW source

Trusted TypeScript authoring input and its referenced prompts, schemas,
manifests, and subworkflows.

### Compiled bundle

The immutable, data-only runtime input produced from an ADW source. Its
canonical representation contains every value that can affect orchestration
decisions.

### Workflow checksum

The SHA-256 digest of the canonical compiled bundle, including its semantic
version fields and resolved resources.

### Run

One execution of an exact compiled bundle against a pinned starting repository
commit and a snapshot of decision-affecting configuration.

## Execution identity

### Node definition

An immutable node declared in the compiled bundle. A definition describes what
may execute; it is not itself an execution record.

### Node invocation

One activation of a node definition through a selected graph transition. A loop
may activate the same definition more than once, producing distinct
invocations.

### Node attempt

One operational attempt within an invocation. Transport retries, process
restarts that permit replay, and declared harness fallbacks create attempts;
they do not create new graph invocations.

### Invocation sequence

A monotonically increasing integer assigned from durable history when a node is
activated. It provides stable identity and scheduling order within a run.

## State and decisions

### Event

An immutable, serializable fact already accepted into the ordered durable
history of a run. An event contains all nondeterministic observations needed by
the reducer.

### Projection

The immutable run state obtained by reducing a compiled bundle and ordered
events.

### Orchestration intent

A pure description of the next action Kairo wants committed, such as activating
a node, starting an attempt, requesting approval, or failing a run. An intent
contains no generated ID, current timestamp, lease, or unrecorded observation.

### Outcome

A stable symbolic result emitted by a completed invocation, such as `passed`,
`failed`, `approved`, or `rejected`. Transitions match outcomes and may also
evaluate restricted conditions over projected data.

### Transition

A declared route from one node outcome to another node definition or terminal
result.

### Default transition

An explicitly marked outgoing transition selected only when no conditioned
transition matches. A node may declare at most one default for an outcome.

### Loop counter

A named non-negative integer incremented only when a selected transition
explicitly declares that counter. Attempts never increment loop counters.

## Failure and recovery

### Expected failure

A declared domain or operational failure represented as typed data and
`Result.Err`.

### Programming defect

An invariant violation caused by incorrect Kairo code. Programming defects may
throw and are not converted into ordinary workflow outcomes.

### Interruption

Loss of an active attempt before Kairo durably records whether its expected
effect completed.

### Recovery policy

The declared rule for deciding how an interrupted operation may proceed:
`replay_safe`, `verify_then_replay`, `resume_supported`,
`manual_reconciliation`, or `never_automatically_retry`.

### Repair

A graph transition to another invocation after a valid execution produced an
unacceptable result, such as failed tests.

### Retry

Another attempt of the same invocation after an operational failure.

### Fallback

Another attempt of the same invocation using a different declared provider or
harness.

### Compensation

A separately declared operation that attempts to reverse a completed side
effect.
