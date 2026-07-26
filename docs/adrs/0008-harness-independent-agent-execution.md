# ADR-0008: Agent attempts use normalized harness and artifact ports

- Status: Accepted
- Date: 2026-07-26

## Context

Agent nodes must run through Claude Code, Codex, OpenCode, Pi, or a deterministic
fake without putting provider flags, response envelopes, session identifiers,
or transcript formats into compiled workflows. A provider can fail after an
attempt starts, and a process can stop after a resumable session exists. Large
transcripts cannot live directly in the event stream.

## Decision

The application layer declares normalized `AgentHarness`,
`AgentHarnessRegistry`, and `ArtifactWriter` ports. Harness adapters receive
only the compiled role, resolved prompt, output schema, capabilities, working
directory, and durable execution identity. Run configuration snapshots an
ordered `agentHarnesses` list. ADR-0017 later permits an agent node to
intentionally pin one harness; nodes without a pin remain provider-neutral.

An attempt records its selected harness. A known harness or validation failure
records `attempt.failed`. When another snapshotted harness remains, the event
marks a fallback and the scheduler creates the next attempt within the same
invocation. Exhausting the policy fails the invocation and then the run.

Resumable session tokens are durable attempt facts. Restart recovery resumes
the same attempt and harness when the node declares `resume_supported`.
Interruptions without a recorded token continue to require reconciliation.

Agent output is independently validated against the compiled JSON schema even
when a harness offers native structured output. Invalid data becomes the typed
`invalid_structured_output` attempt failure.

Harness transcripts and validated output use the artifact writer:

```text
temporary write
→ checksum
→ atomic no-overwrite publication
→ attempt.artifact_published
```

The event and SQLite projection store only the checksum-bearing reference.

## Failure behavior

- Missing harness configuration is a typed application input failure.
- An unavailable harness, process failure, malformed harness response, invalid
  structured output, or artifact write failure is typed and serializable.
- Failed primary execution can select only the next snapshotted fallback.
- Resume uses the recorded harness and token; it never silently starts a new
  provider session.
- A failed artifact write prevents successful invocation completion.

## Alternatives considered

- Provider fields in agent nodes were initially rejected because they make an
  ADW harness-specific. ADR-0017 supersedes that restriction with an explicit
  optional pin while preserving provider-neutral nodes by default.
- Trusting provider-side schema enforcement was rejected because adapters have
  different output contracts and versions.
- Storing transcripts in events was rejected because it makes replay history
  unbounded.
- Treating fallback as a new invocation was rejected because it would alter
  graph traversal and loop counters.

## Executable acceptance scenarios

1. One compiled ADW produces the same output through every supported harness.
2. Invalid structured output becomes a durable typed node failure.
3. A primary harness failure and fallback success produce two attempts in one
   invocation.
4. A recorded session token resumes the interrupted attempt.
5. Transcript and output artifacts are checksum-bearing durable references.
