# ADR-0018 — Agent nodes may select a model per harness

- Status: Accepted
- Date: 2026-07-26

## Context

Kairo can pin or route an agent node to Claude Code, Codex, OpenCode, or Pi, but
the normalized harness request does not select a model. Each CLI therefore uses
its ambient default, which may differ between machines or change over time.

A single model string is insufficient because model identifiers are
harness-specific and one node may have an ordered fallback policy spanning
multiple harnesses.

## Decision

An agent node may declare `models`, a non-empty object whose keys are harness
IDs and whose values are non-empty model identifiers:

```typescript
models: {
  codex: 'gpt-5.2-codex',
  'claude-code': 'claude-opus-4-5',
  opencode: 'openai/gpt-5.2',
  pi: 'anthropic/claude-opus-4-5',
}
```

The map is part of the compiled workflow and its checksum. After resolving the
harness for an attempt using ADR-0016 and ADR-0017, Kairo resolves the model as
`node.models[selectedHarness]`.

The resolved model is recorded on `attempt.started`, projected with the
attempt, independently checked by the reducer during replay, and passed through
the normalized harness request. Each adapter maps it to that CLI's explicit
model option. Resumed execution reuses the model recorded on the attempt.

If an agent node omits `models`, or its map has no entry for the selected
harness, the request omits an explicit model and the harness retains its
existing configured default. This preserves existing workflows.

`models` is invalid on command, approval, and complete nodes. Empty harness IDs,
empty model identifiers, and an empty map are compilation failures.

## Consequences

- Workflow authors can select provider-specific models without sacrificing
  ordered harness fallback.
- Changing a model selection changes the compiled workflow checksum.
- Durable history records the exact explicit model selected for each attempt.
- Agents cannot choose or change their own model.
- Existing workflows and histories without explicit models remain valid.
- Ambient harness defaults remain possible but are intentionally less pinned
  than an explicit model map.
