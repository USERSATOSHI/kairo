# ADR-0015 — Agent context-preserving engineering loops

- Status: Accepted
- Date: 2026-07-26

## Context

Feature-development workflows originally routed failed tests and rejected
reviews to dedicated repair-agent nodes. Those agents start separate harness
sessions, so they lose the implementation agent's reasoning context. The
implementation agent also did not receive the durable command or review output
that caused the repair traversal.

Harnesses already return durable resume tokens, but Kairo previously used them
only to recover an interrupted attempt within one node invocation.

## Decision

Repeated invocations of the same agent node reuse the most recent successful
session token for the selected harness by default. The new invocation records
that token in `attempt.started`, making the context decision durable and
replayable.

An agent node may declare `clearContext: true` to always start a fresh harness
session. This is an author-controlled escape hatch for workflows whose session
context becomes too large or should not cross invocations.

When an agent invocation is activated by a source invocation with output, the
coordinator appends that durable source node, outcome, and output to the agent's
base prompt. Command execution records exit code, standard output, and standard
error so validation failures contain an actionable reason.

The feature-development workflow uses one implementation agent. Validation runs
linting, formatting, and tests in sequence. Validation failures and rejected
read-only reviews loop back to that implementation agent through explicit
bounded counter transitions.

## Consequences

- Repair work retains the implementation harness session and reasoning context.
- Validation and review feedback are explicit deterministic prompt inputs.
- Session reuse survives coordinator restarts because tokens and source outputs
  are durable events.
- `clearContext: true` opts an agent out of cross-invocation reuse.
- Dedicated test-repair and review-repair agent roles are removed from the
  packaged feature workflow.
- Compiled workflows that declare `clearContext` gain one optional node field;
  workflows that omit it retain the existing serialized node shape.
