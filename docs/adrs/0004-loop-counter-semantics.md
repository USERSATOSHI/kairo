# ADR-0004: Loop counters track explicit graph traversals

- Status: Accepted
- Date: 2026-07-26

## Context

Repair loops and operational retries have different meanings. Inferring repair
counts from how many times a command or harness was attempted would cause
provider failures to consume workflow repair limits.

## Decision

A named loop counter increments only when the selected transition explicitly
declares `increment`. The increment and target invocation activation are one
logical state change.

Conditions observe counters before the candidate transition's increment. The
compiler requires every graph cycle to contain a bounded counter increment and
a condition that prevents traversal after the declared limit.

Attempts never alter loop counters.

## Serialized representation

```ts
interface CompiledTransition {
	increment?: string;
}

interface CompiledLimit {
	counter: string;
	max: number;
}

interface RunState {
	counters: Readonly<Record<string, number>>;
}
```

## Failure behavior

Unknown counters, negative limits, counter overflow, and cycles without an
effective bound are compiler or typed runtime failures as appropriate. A
transition disabled by its bound is simply not a matching transition.

## Counterexample

If three network retries of a test command increment `testRepair`, the workflow
may exhaust its repair allowance before a repair node has run once.

## Executable acceptance scenarios

1. Selecting an annotated repair transition increments its named counter once.
2. Starting another attempt does not change the counter.
3. The repair transition stops matching at its declared bound.
4. The terminal failure transition is selected at the bound.
