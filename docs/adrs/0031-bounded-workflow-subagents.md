# ADR-0031: Workflow agents may invoke bounded declared subagents

- Status: Accepted
- Date: 2026-07-30

## Context

Some agent stages benefit from dynamically delegating small, independent
tasks. A planner may ask separate scouts to inspect architecture, tests, and
repository history, and it may discover the useful split only after reading the
work item. Modeling every possible scout call as a graph node makes that
internal decomposition rigid.

Provider-native delegation is not a sufficient workflow contract. Harnesses
expose different child-agent APIs, permission behavior, limits, transcripts,
and interruption semantics. Allowing an ambient provider task tool would also
hide authority from the compiled workflow and could let a child exceed the
parent node's permissions.

Kouro must retain ownership of graph scheduling, durable recovery, permissions,
limits, and approvals. A child agent cannot become an implicit workflow node.

## Decision

`WorkflowBuilder.subagent(name, definition)` declares a reusable child-agent
definition and returns a builder-owned `SubagentHandle`. An agent node
authorizes one or more definitions through `agent.uses(...subagents)`.
Subagents are not graph nodes: their handles cannot be used with `startAt()`,
transition targets, counters, or transitions.

Every subagent definition explicitly declares the singleton
`repository.read` capability plus positive `maxInvocations` and
`maxConcurrent` limits. One parent harness execution owns fresh counters for
each authorized definition. The parent may invoke several definitions and may
invoke one definition repeatedly or concurrently within those bounds.

Kouro exposes one normalized `subagent` tool to the parent harness. A call
contains an authorized subagent ID and a non-empty task. Kouro:

1. validates authorization and limits;
2. resolves the child harness from its optional pin or the parent harness;
3. resolves the child model for that harness;
4. executes the child through the existing `AgentHarnessRegistry` in the exact
   parent worktree;
5. independently validates the child output schema; and
6. returns the stable child call ID and validated output to the parent.

Child capabilities must be a subset of both workflow permissions and the
parent node's capabilities. Children receive no subagent tool, so delegation is
one level deep. They cannot broaden permissions, alter graph state, select
transitions, change limits, publish delivery artifacts, or bypass approvals.

Claude receives the normalized tool through an in-process SDK MCP server.
Codex receives it as an App Server dynamic tool. OpenCode receives a
Kouro-owned custom tool backed by an authenticated loopback callback. Pi
receives it as an in-process custom tool. Provider-native delegation remains
disabled.

Nested executions are subordinate effects of the parent attempt, not
`NodeInvocation` or `NodeAttempt` records. Stable call IDs, harness/model
selection, result status, and child transcripts are appended to the parent
harness transcript artifact. Because the initial feature permits read-only
children only, replay after interruption cannot duplicate repository
side-effects. Durable independently recoverable child attempts are deferred.

## Consequences

- Workflow authors can declare multiple typed subagent roles per parent agent.
- Dynamic scouting remains bounded without turning provider sessions into
  workflow schedulers.
- Capability subset checks and invocation limits fail closed.
- Every built-in harness exposes the same logical tool and result contract.
- Child work is inspectable in the parent transcript but is not independently
  retryable or resumable.
- The compiled workflow format and checksum include subagent definitions and
  parent authorization. Package compilation emits IR version 2 and compiler
  version 0.2.0; previously compiled IR version 1 bundles remain readable.
- The first version accepts only `repository.read` child capability. Writable,
  executable, networked, recursively delegating, and independently durable
  subagents require a later ADR.

## Alternatives considered

### Explicit graph nodes only

This remains preferred when the child stage and its transitions are known in
advance, but it cannot express a parent-selected number of specialized scouts
without predeclaring the entire decomposition.

### Provider-native task tools

Native tools differ across providers and do not consistently enforce Kouro's
compiled limits, capability subset, transcript, and cancellation contracts.

### Arbitrary nested workflow graphs

Letting an agent synthesize nodes or transitions would violate the pinned
workflow checksum and deterministic scheduling contract.

### Durable child attempts in the event stream

Independent child attempts would require new recovery, lifecycle, projection,
and scheduling semantics. Read-only subordinate executions provide the useful
scouting case without prematurely introducing a second graph hierarchy.
