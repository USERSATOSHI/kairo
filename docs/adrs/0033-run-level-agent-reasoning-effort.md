# ADR-0033: Runs may snapshot a portable agent reasoning effort

- Status: Accepted
- Date: 2026-08-03

## Context

Operators launching a workflow need to trade execution latency and cost against
reasoning depth. Provider defaults are useful, but they cannot express an
intentional per-run choice. Provider-specific controls also differ: Codex uses
turn effort, Claude exposes SDK effort, OpenCode uses model variants, and Pi
uses thinking levels.

Reasoning configuration affects agent output and must not exist only as mutable
browser state. Active runs must retain the exact operator choice used when
executing parent agents and their bounded workflow subagents.

## Decision

Run creation accepts an optional `reasoningEffort` with the portable values
`low`, `medium`, or `high`. The local composition snapshots it as
`agentReasoningEffort` in durable run configuration. Omitting the value keeps
each provider's configured default.

The coordinator passes the snapshotted value through the normalized harness
request. Bounded subagents inherit the same value from their parent attempt by
default. ADR-0034 subsequently allows compiled agent and subagent definitions
to override this fallback. Harnesses map the effective value to their installed
provider boundary:

- Codex App Server `turn/start.effort`;
- Claude Agent SDK `effort`;
- OpenCode agent/model `variant`; and
- Pi `thinkingLevel`.

Kouro intentionally exposes only the common `low`, `medium`, and `high`
intersection. Provider-specific values such as `minimal`, `xhigh`, `max`, or
`ultra` are deferred until Kouro has a capability-discovery contract that can
validate them against the selected harness and model.

## Consequences

- Web-created runs can make an explicit cost/latency/quality choice.
- Replay and resumed execution read the same durable run setting.
- Parent and child agents without compiled overrides use one coherent effort
  policy.
- Existing runs and requests remain compatible because the setting is optional.
- The setting influences provider inference, not graph scheduling, transitions,
  permissions, limits, approvals, or deterministic event reduction.

## Alternatives considered

### Browser-only provider flags

Rejected because refresh, resume, or recovery could silently lose the setting.

### Arbitrary strings

Rejected because values accepted by one provider may fail or change meaning in
another provider.

### Workflow-level compiled effort

Initially deferred and subsequently adopted by ADR-0034. The run value remains
the operator-selected fallback for workflow definitions that omit an effort.
