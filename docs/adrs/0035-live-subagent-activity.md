# ADR-0035: Subagent activity streams through the parent observation channel

- Status: Accepted
- Date: 2026-08-03

## Context

Kouro records a bounded subagent's transcript in the parent attempt artifact
after that child finishes. During a long-running Claude Opus child execution,
the operator can see the parent's MCP tool call but cannot see the child's
reasoning, messages, or tool activity until completion.

Subagents remain subordinate effects rather than graph invocations. Making
partial child output durable orchestration history would incorrectly give
provider timing a role in replay and recovery.

## Decision

The agent executor copies subagent lifecycle observations into the existing
best-effort parent invocation activity record. It emits newline-delimited
Kouro envelopes for:

- `kouro.subagent.started`, containing stable call and role metadata;
- `kouro.subagent.chunk`, containing one provider transcript chunk; and
- `kouro.subagent.finished`, containing success, output, or failure.

Every envelope carries the stable Kouro call ID, subagent ID, delegated task,
harness, and optional model and reasoning effort. Writes for one parent attempt
are serialized before the activity completion marker, including when several
children run concurrently.

The web transcript parser correlates envelopes by call ID and incrementally
builds one nested session per child. Child provider bytes continue through the
existing provider-neutral transcript parser, so Claude reasoning, messages,
tool calls, and tool results use the same readable presentation as parent
activity.

These envelopes are ephemeral observations under ADR-0024. They are not run
events, node invocations, attempts, artifacts, scheduler inputs, approval
inputs, or recovery state. The completed checksum-verified parent transcript
artifact remains the durable authority and retains the final child records
defined by ADR-0031.

## Consequences

- Operators can watch Claude Opus and other harness subagents while they run.
- Parallel child streams remain distinguishable even when chunks interleave.
- Activity write failures remain best-effort and cannot fail agent execution.
- A crash may leave live child activity incomplete; completed artifacts remain
  authoritative.
- No API shape or deterministic domain event changes are required.

## Alternatives considered

### Independent child activity endpoints

Rejected because subagents do not have durable invocation identities and the
parent activity channel already spans worker and serving processes.

### Partial child transcript artifacts

Rejected because artifacts require atomic, checksum-verified publication and
must not be rewritten incrementally.

### Provider-native child UI only

Rejected because it would make observation harness-specific and unavailable to
the Kouro web console.
