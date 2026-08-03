# ADR-0034: Workflow agents may override reasoning effort

- Status: Accepted
- Date: 2026-08-03

## Context

A single workflow often contains roles with different inference needs. A
planner or reviewer may require deep reasoning, while repository scouts and
mechanical implementation stages can use lower-cost effort. The run-level
policy introduced by ADR-0033 cannot express that difference.

Reasoning effort affects agent output, so author-selected values must be part
of the compiled workflow checksum rather than mutable launch state. Existing
workflows and operator control must remain compatible.

## Decision

Agent and bounded-subagent definitions accept an optional `reasoningEffort`
with the portable values `low`, `medium`, or `high`.

For a graph agent, Kouro resolves the effective value in this order:

1. the compiled agent definition;
2. the durable run-level fallback; and
3. the harness provider default.

For a bounded subagent, Kouro resolves the effective value in this order:

1. the compiled subagent definition;
2. the parent agent's effective value; and
3. the harness provider default.

The compiler validates the portable values and includes them in canonical
workflow bytes and checksums. Package compilation emits IR version 3 and
compiler version 0.3.0; previously compiled IR versions remain readable.

The setting influences only provider inference. It does not alter scheduling,
transitions, permissions, limits, approvals, recovery policy, or the depth of
the subagent hierarchy.

## Consequences

- Workflow authors can budget reasoning depth per role.
- Operators retain one useful launch-time fallback for definitions that omit
  an effort.
- Parent and child agents may intentionally use different effort levels.
- Resumed graph agents retain their compiled and durable fallback inputs.
- Existing ADWs remain compatible because every new field is optional.

## Alternatives considered

### Run-level effort only

Rejected as the sole policy because it forces simple and complex roles to use
the same latency and cost profile.

### Per-harness effort maps

Deferred. The common three-level vocabulary is portable, while provider-only
levels require capability discovery and harness-specific validation.

### Mutable web overrides for individual nodes

Rejected because browser-only values are not bound to the compiled workflow or
durably recoverable run configuration.
