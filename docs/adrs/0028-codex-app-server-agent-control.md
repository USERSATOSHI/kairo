# ADR-0028: Codex uses App Server for bidirectional agent control

- Status: Accepted
- Date: 2026-07-29

## Context

The Codex harness currently invokes `codex exec` as a one-shot subprocess and
parses its JSONL output after the process exits. That boundary supports
structured output and resumable threads, but it cannot apply durable operator
steering to an active turn, answer tool approvals, or terminate the provider
turn when Kouro records an interrupt.

Kouro must retain ownership of workflow scheduling, attempt identity, durable
operator input, recovery, and artifacts. Provider session state and live
control must not become a second orchestration authority.

## Decision

The Codex harness uses `codex app-server` over its local stdio JSON-RPC
transport. One supervised App Server process owns one active Codex attempt.
Kouro starts or resumes a Codex thread, records the thread ID as the durable
resume token, starts a turn with a capability-derived sandbox policy, streams
notifications into the existing activity channel, and disposes the process
when the attempt ends.

Operator steering is an append-only run event bound to the active invocation
and attempt. The active harness polls this durable control mailbox and sends
pending messages with `turn/steer`. Acceptance or rejection is recorded as a
second durable event. Interrupt requests remain durable attempt facts and are
forwarded to App Server with `turn/interrupt`.

Command and file-change approval requests are decided from the node's compiled
capabilities. Kouro never grants a capability that the compiled node did not
declare. Provider notifications remain observational; only normalized Kouro
events and checksum-bearing artifacts affect replay.

## Consequences

- Codex supports live steering, real interruption, tool approval responses,
  early session-token persistence, and structured progress events.
- Repeated graph invocations resume the recorded Codex thread without keeping
  an App Server process alive between invocations.
- The installed Codex App Server protocol is an infrastructure compatibility
  boundary. Malformed or unsupported responses fail as typed harness errors.
- App Server sandboxing improves Codex isolation, but provider-neutral host
  sandboxing remains separate work.
- Claude Code, OpenCode, and Pi retain their existing adapters until their SDK
  integrations are implemented independently. ADR-0029 records that subsequent
  decision.

## Alternatives considered

- Keeping `codex exec` and killing the process for steering was rejected
  because it cannot inject guidance into the active turn or answer approvals.
- Replacing Kouro orchestration with an agent SDK was rejected because provider
  sessions do not own workflow checksums, durable graph history, recovery, or
  review-bound delivery.
- One shared App Server for every run was rejected because it couples failures
  and mutable provider state across attempts.
