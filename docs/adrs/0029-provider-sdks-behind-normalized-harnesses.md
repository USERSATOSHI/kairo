# ADR-0029: Provider SDKs implement normalized agent harnesses

- Status: Accepted
- Date: 2026-07-29

## Context

Claude Code, OpenCode, and Pi currently run through one-shot CLI process
adapters. Those adapters preserve structured output and resumable sessions,
but they cannot reliably steer or interrupt an active provider turn through
the same normalized control channel used by the Codex App Server adapter.

Kouro must not delegate workflow scheduling, durable history, recovery,
permissions, or artifact publication to a provider SDK. SDK session state is
an infrastructure implementation detail behind the existing
`AgentHarness` port.

## Decision

The remaining provider adapters use their official TypeScript SDKs:

- Claude uses `@anthropic-ai/claude-agent-sdk` streaming input and query
  controls.
- OpenCode uses `@opencode-ai/sdk` with one supervised local server and client
  per active attempt.
- Pi uses `@earendil-works/pi-coding-agent` with one in-process
  `AgentSession` per active attempt.

Each adapter:

1. starts or resumes the exact provider session represented by the durable
   attempt token;
2. records a new token as soon as the provider creates the session;
3. derives available tools and permission behavior from compiled
   capabilities;
4. forwards pending durable steering and interruption through the provider's
   programmatic control API;
5. captures a provider transcript and normalizes the final agent output; and
6. disposes every provider-owned process, server, subscription, or session
   when the attempt ends.

Claude and OpenCode retain provider session IDs as resume tokens. Pi persists
sessions as JSONL and uses the exact session file as the new resume token. The
Pi adapter also resolves legacy session-ID tokens by searching the current
project's session index before resuming.

Provider-native structured output is used when available, but Kouro still
validates the final value independently against the compiled workflow schema.
The worktree sandbox remains the outer filesystem boundary; SDK tool limits
are defense in depth and do not replace it.

## Consequences

- All supported harnesses can receive durable live steering and interruption.
- Claude and Pi no longer require their standalone CLI executables for normal
  harness execution. OpenCode's SDK still supervises its local server binary.
- SDK exceptions, malformed responses, and missing legacy sessions become
  typed harness failures.
- Provider SDK upgrades are compatibility-sensitive infrastructure changes and
  require adapter contract tests.
- Existing workflow, scheduler, event, artifact, and recovery semantics do not
  change.

## Alternatives considered

- Keeping the one-shot CLI adapters was rejected because live steering cannot
  be injected safely after process start.
- Moving orchestration into each SDK was rejected because provider sessions do
  not own workflow checksums, graph limits, approvals, recovery policies, or
  review-bound delivery.
- Running one shared OpenCode server or Pi session for every run was rejected
  because it couples mutable provider state and failures across attempts.
