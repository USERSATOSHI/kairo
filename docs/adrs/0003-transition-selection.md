# ADR-0003: Sequential transitions select exactly one route

- Status: Accepted
- Date: 2026-07-26

## Context

If transition declaration order resolves ambiguity, semantically equivalent ADW
source can make different routing decisions after harmless reformatting or
compilation changes. Silent no-match behavior can also leave runs stuck.

## Decision

The initial runtime is sequential. For a completed invocation:

- exactly one non-default outgoing transition may match;
- more than one match is `ambiguous_transition`;
- zero matches selects the single explicit default, when present;
- zero matches without a default is `missing_transition`;
- declaration order has no semantic effect;
- fan-out and joins are deferred.

Conditions are evaluated using a restricted, versioned expression language over
snapshotted inputs, outputs, counters, artifacts, and configuration.

## Serialized representation

```ts
interface CompiledTransition {
	id: string;
	from: { nodeId: string; outcome: string };
	to: { nodeId: string };
	condition?: Expression;
	default?: true;
	increment?: string;
}
```

Compiled transition IDs are stable and unique.

## Failure behavior

Ambiguous and missing selections are expected typed runtime failures. Invalid
targets, duplicate defaults, arbitrary expressions, and unknown references are
compiler failures.

## Counterexample

Two conditions, `status == "failed"` and `exitCode != 0`, may both match the
same output. Selecting whichever was written first hides a malformed workflow.
Kouro fails the selection instead.

## Executable acceptance scenarios

1. One matching condition selects its transition.
2. Two matching conditions fail regardless of declaration order.
3. No match selects an explicit default.
4. No match without a default fails.
5. Reordering transitions does not change the selected transition or error.
