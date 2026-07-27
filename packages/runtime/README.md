# `@kouro/runtime` — Pure Deterministic Runtime

The **functional core** of the Kouro workflow engine. Pure, side-effect-free functions for event-sourcing state reconstruction, transition selection, and orchestration intent scheduling.

This package has **zero side effects** — no I/O, no database, no network, no logging, no clocks. Everything is deterministic: given the same compiled workflow artifact and the same ordered events, it produces the same state and the same intents.

## Architecture

```
CompiledWorkflowArtifact + RunEvent[]
    │
    ▼
reduceRun()  ───►  RunState
    │
    ▼
scheduleRun() ───►  OrchestrationIntent[]
    │
    ▼
simulate()    ───►  { state, intents, canonical }
```

The three stages form a pipeline used by the imperative shell (RunCoordinator):

```
Event Store → reduceRun() → RunState → scheduleRun() → Intent → RunCoordinator dispatches
```

## Core Functions

### simulate()

The primary public API — composes the full pipeline:

```typescript
import { simulate } from '@kouro/runtime';

const result = simulate(artifact, events);
if (result.isOk()) {
  const { state, intents, canonical } = result.unwrap();
  // state: RunState — current projected state
  // intents: OrchestrationIntent[] — what to do next
  // canonical: string — deterministic JSON for checksumming
}
```

Equivalent to:

```typescript
const state = reduceRun(artifact, events);
const intents = scheduleRun(artifact, state);
const canonical = canonicalJson({ state, intents });
```

### reduceRun()

Replays an ordered sequence of events against a compiled artifact to produce the current state:

```typescript
import { reduceRun } from '@kouro/runtime';

const stateResult = reduceRun(artifact, events);
```

The reducer is an **event-sourcing state machine** — it handles all 20 event types:

| Event | State Effect |
|-------|-------------|
| `run.created` | Initializes run state, validates checksum, sets counters to 0 |
| `run.time_observed` | Updates `observedAt` (clock must not go backwards) |
| `run.paused` / `run.resumed` | Toggles run status |
| `run.cancelled` | Marks run cancelled, cancels all non-terminal invocations |
| `invocation.activated` | Creates `NodeInvocation` with validated sequence/node/transition |
| `attempt.started` | Adds `NodeAttempt` to invocation |
| `attempt.failed` | Marks attempt failed, supports fallback retry |
| `attempt.interrupted` | Marks attempt interrupted |
| `invocation.completed` | Marks invocation succeeded with outcome/output |
| `invocation.skipped` | Marks invocation succeeded with skip outcome (validates skip binding) |
| `approval.requested` / `granted` / `rejected` | Manages approval state transitions |
| `run.completed` | Terminates run as succeeded or failed |

**Invariants enforced:**
- Events must arrive in strict sequential order
- Terminal states reject all further events
- `waiting_for_approval` only accepts approval/skip events
- Invocation sequences must match `nextInvocationSequence`
- Approval and skip bindings must match current projected state

### scheduleRun()

Given the current run state, determines what the engine should do next:

```typescript
import { scheduleRun } from '@kouro/runtime';

const intentsResult = scheduleRun(artifact, state);
```

Decision priority (first match wins):

1. Run not running → no-op
2. Duration limit exceeded → `run.complete { result: 'failed' }`
3. No invocations → `invocation.activate` for entry node
4. Interrupted invocation exists → recovery intent based on node's `recoveryPolicy`
5. Failed invocation exists → `run.complete { result: 'failed' }`
6. Pending invocation → `approval.request`, `run.complete`, or `attempt.schedule`
7. Completed invocation with no transition → resolve transition → `invocation.activate`
8. Nothing to do → no-op

### selectTransition()

Determines which transition to follow after a node completes:

```typescript
import { selectTransition } from '@kouro/runtime';

const transition = selectTransition(workflow, state, invocation);
```

Algorithm: filter transitions by `(nodeId, outcome)`, evaluate conditions, select exactly one. Multiple matches = `AmbiguousTransition`. No match without default = `MissingTransition`.

### evaluateExpression()

Evaluates the restricted expression language:

```typescript
import { evaluateExpression } from '@kouro/runtime';

const result = evaluateExpression(expression, state, output);
```

Supported operators: `eq`, `gte`, `lt`, `and` (short-circuit), `or` (short-circuit), `not`.

Value references can read from:
- `{ scope: 'counter', name: 'retries' }` — reads `state.counters.retries`
- `{ scope: 'output', path: ['result'] }` — reads from invocation output

## Expression Language

The decision expression language is intentionally restricted — no arbitrary JavaScript execution:

```typescript
// Counter-based condition: retry up to 3 times
{
  op: 'lt',
  left: { scope: 'counter', name: 'retry_count' },
  right: 3
}

// Output-based condition: check result
{
  op: 'eq',
  left: { scope: 'output', path: ['approved'] },
  right: true
}

// Compound condition
{
  op: 'and',
  expressions: [
    { op: 'lt', left: { scope: 'counter', name: 'attempts' }, right: 5 },
    { op: 'eq', left: { scope: 'output', path: ['quality'] }, right: 'acceptable' },
  ]
}
```

## Error Types (12 Stable Variants)

| Error Kind | Code | Meaning |
|------------|------|---------|
| `InvalidEventSequence` | 0 | Events out of order |
| `WorkflowChecksumMismatch` | 1 | Event references wrong workflow |
| `UnknownNode` | 2 | Node ID not in compiled bundle |
| `UnknownInvocation` | 3 | Invocation sequence not found |
| `InvalidInvocationSequence` | 4 | Wrong next sequence number |
| `InvalidAttemptNumber` | 5 | Wrong attempt number |
| `IllegalStateTransition` | 6 | Event invalid for current state |
| `AmbiguousTransition` | 7 | Multiple transitions match |
| `MissingTransition` | 8 | No matching transition |
| `InvalidExpression` | 9 | Expression evaluation error |
| `UnknownCounter` | 10 | Referenced counter not found |
| `StaleApproval` | 11 | Approval binding doesn't match current state |

## Exported API

| Export | Kind | Source |
|--------|------|--------|
| `simulate(artifact, events)` | function | `simulate.ts` |
| `reduceRun(artifact, events)` | function | `reducer.ts` |
| `scheduleRun(artifact, state)` | function | `scheduler.ts` |
| `selectTransition(workflow, state, invocation)` | function | `transitions.ts` |
| `evaluateExpression(expression, state, output)` | function | `expression.ts` |
| `RuntimeErrorKind` | const enum | `errors.ts` |
| `RuntimeError` | type | `errors.ts` |
| `SimulationOutput` | interface | `simulate.ts` |
| `toErr`, `toRuntimeError` | helpers | `errors.ts` |

## Dependencies

| Package | Purpose |
|---------|---------|
| `@kouro/adw` | `canonicalJson` for canonical JSON serialization |
| `@kouro/domain` | All domain types |
| `@usersatoshi/results` | `Result<T, E>` type |
