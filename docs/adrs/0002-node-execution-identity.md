# ADR-0002: Separate definition, invocation, and attempt identity

- Status: Accepted
- Date: 2026-07-26

## Context

One workflow node may execute repeatedly because a graph loop activates it
again. An individual activation may also be retried after interruption or use a
fallback harness. Treating both cases as another "node run" makes counters,
recovery, audit history, and UI state ambiguous.

## Decision

Kouro uses three identities:

- `NodeDefinition`: immutable compiled configuration;
- `NodeInvocation`: one activation through the graph;
- `NodeAttempt`: one operational attempt within an invocation.

A selected transition creates an invocation. Retry, resume fallback, and
provider fallback operate within an invocation and may create attempts.

## Serialized representation

```ts
interface NodeInvocation {
	sequence: number;
	nodeId: string;
	state: InvocationState;
	attempts: readonly NodeAttempt[];
}

interface NodeAttempt {
	number: number;
	state: AttemptState;
	resumeToken?: string;
}
```

Invocation identity in M1 is the durable invocation sequence. Infrastructure
may later attach an opaque external ID without changing runtime identity.

## Failure behavior

The reducer returns a typed invariant failure when an attempt references an
unknown invocation, skips an attempt number, or is appended to a terminal
invocation.

## Counterexample

`test → repair → test` creates two test invocations. A worker interruption
during the second invocation creates another attempt of that second invocation;
it does not represent another traversal of the repair loop.

## Executable acceptance scenarios

1. A repair transition creates a second invocation of the test definition.
2. An operational retry creates attempt two inside the same invocation.
3. The retry does not change any loop counter.
4. An attempt cannot be added to a succeeded invocation.
