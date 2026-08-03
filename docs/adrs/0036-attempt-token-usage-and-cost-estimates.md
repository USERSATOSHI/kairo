# ADR-0036: Durable attempt token usage and derived cost estimates

- Status: Accepted
- Date: 2026-08-03

## Context

Kouro captures what agents produce but not what they consume. An operator
cannot see how many tokens a task used or what it cost, so expensive attempts
are invisible until the bill arrives. The factory reference
(`super-simple-software-factory`) treats per-phase cost observability as a core
feature; Kouro has no usage data at the harness boundary at all.

Provider SDKs expose token counts on every major harness path (Claude result
`usage`, Codex turn `tokens`, OpenCode session `tokens`, Pi session stats), but
none of it is persisted or displayed.

## Decision

### Durable usage, derived cost

Kouro persists **token usage only**. Money is never stored in the event
stream. USD cost is a derived display value computed from durable usage and a
versioned price table, so a price correction never rewrites history.

Add `TokenUsage` to the domain model:

```ts
interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}
```

### A new append-only event

Add `attempt.usage_recorded` to the run event union. The run coordinator
appends it after a successful agent attempt publishes its artifacts and before
`invocation.completed`, so the reducer folds usage into an attempt that is
still `running`. Command attempts never carry usage.

The reducer rejects the event when:

- the invocation is not active;
- the attempt number does not match the latest attempt;
- the node is not an agent node; or
- the token counts are not safe non-negative integers.

Replay of the same ordered events reproduces the same usage state, preserving
the determinism contract.

### Best-effort harness extraction

Each harness reads usage from its SDK where the shape is known, guarded by
runtime validation so a changed SDK can never break execution:

| Harness | Source | Mapped fields |
|---|---|---|
| Claude Code | result message `usage` | input, output, cache read/write |
| Codex | completed turn `tokens` | input, output, reasoning, cached input |
| OpenCode | session `tokens` | input, output, reasoning, cache read/write |
| Pi | `getSessionStats()` | input, output, cache read/write |

The scripted fake harness accepts usage directly in scripted results, so tests
can assert the full pipeline. Usage is optional everywhere: a harness or SDK
version that reports nothing degrades to today's behavior.

### Price table and estimation

`packages/domain/src/pricing.ts` holds a small, prefix-matched price table
(USD per million tokens) for common models and a pure `estimateCostUsd(usage,
model)` function. Unpriced models return `undefined` and render as "unpriced"
instead of a fabricated number. OpenCode-style `provider/model` ids are
normalized before matching.

### Per-task surface

- Run details show per-attempt tokens and estimated cost.
- The run header shows a run-level token and cost estimate.
- The timeline blocks carry usage and cost in their tooltip.
- Ticket run views (`TicketRunView`) carry summed usage and an estimated cost,
  computed in the API's run query where per-attempt model context still exists.

## Alternatives considered

- **Persist cost as reported by providers.** Claude and Pi report `cost_usd`
  directly. Rejected: reported cost mixes currencies, discounts, and provider
  accounting, and would make replay depend on provider billing behavior.
- **Compute cost only in the browser.** Rejected for ticket-level display,
  where the browser only receives aggregated views without per-attempt model
  context.
- **A dedicated usage table.** Rejected: the append-only event stream is the
  audit record and the reducer already maintains attempt state.

## Invariants affected

- The run event union grows by one event; old streams replay unchanged.
- `NodeAttempt` gains an optional `usage` field; existing state shapes remain
  valid.
- Determinism is preserved: usage is reduced from the durable event, never from
  the provider.

## Tests

- Reducer contract tests: fold, preserve on completion, and reject invalid
  usage, wrong attempt numbers, post-completion writes, and command attempts.
- Pricing unit tests: normalization, per-token math, cache rates, unpriced
  models, and summation.
- Web presentation tests: run-level totals and cost estimates.
- Timeline model tests: blocks carry usage and cost from the latest attempt.
- Harness SDK fake updates in the existing provider-SDK and integration tests.

## Compatibility

No migration is required: events and projections are stored as JSON, and all
new fields are optional. Older stored attempts render without usage.
