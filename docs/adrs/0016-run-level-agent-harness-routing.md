# ADR-0016 — Runs route agent nodes to ordered harness policies

- Status: Accepted
- Date: 2026-07-26

## Context

One workflow can benefit from different coding agents at different stages. For
example, an operator may want Claude Code to plan, OpenCode to implement, Pi to
test, and Codex to review. The compiled workflow must remain provider-neutral,
while harness selection and fallback order must remain durable and
deterministic.

A single run-level `agentHarnesses` list cannot express this routing. This ADR
keeps operator routing outside the portable ADW. ADR-0017 later adds an
intentional workflow-level pin for authors who prefer that tradeoff.

## Decision

Run configuration may snapshot `agentHarnessesByNode`, an object whose keys are
compiled agent node IDs and whose values are non-empty ordered harness ID lists.
The existing `agentHarnesses` list remains the default policy for agent nodes
without an explicit route or workflow-level pin.

For every scheduled agent attempt, the coordinator selects the node-specific
list when present and otherwise selects the default list. Attempt number
selects the corresponding harness within that ordered list, preserving existing
fallback semantics.

The reducer independently derives the same policy from the durable run
configuration and compiled node ID before accepting `attempt.started` or a
fallback failure. Invalid or empty selected policies are typed input failures.

CLI users express routes by qualifying repeated harness options with a node ID:

```text
--harness plan=claude-code
--harness implement=opencode
--harness test=pi
--harness review=codex
```

An unqualified `--harness <id>` continues to add a harness to the default
ordered policy. Repeating a qualified option defines fallback order for that
node.

## Consequences

- Run-level provider policy remains outside compiled workflows and does not
  change their checksums. An optional ADR-0017 workflow pin does.
- Different agent nodes in one run may use different harnesses.
- Each node may retain an independent ordered fallback policy.
- Session reuse remains scoped to the same node and selected harness.
- Existing run configurations containing only `agentHarnesses` remain valid.
- Command, approval, and complete nodes are unaffected; only agent nodes use
  harness routing.
