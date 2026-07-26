# ADR-0017 — Agent nodes may pin a harness

- Status: Accepted
- Date: 2026-07-26

## Context

Run-level routing keeps a workflow portable, but some workflow authors
intentionally design a specific stage for a specific coding harness. Requiring
operators to repeat that fixed choice on every run is noisy and makes the
workflow's intended execution policy implicit.

Kairo still needs portable agent nodes whose harness is selected when a run is
created.

## Decision

An agent node may declare one optional non-empty `harness` ID. Because it affects
execution, the field is part of the compiled workflow and its checksum.

Harness selection uses this precedence:

1. the agent node's compiled `harness`;
2. the run's `agentHarnessesByNode` policy for that node;
3. the run's default `agentHarnesses` policy.

A compiled harness pin selects exactly that harness. Run-level fallback lists do
not extend or override it. Authors who want operator-selected providers or
ordered fallback omit `harness`.

The reducer and coordinator derive the same effective policy before accepting
or scheduling an attempt. A `harness` field on any non-agent node, or an empty
harness ID, is a compilation failure.

## Consequences

- Workflows may explicitly assign different harnesses to different agent nodes.
- Omitting `harness` preserves run-level routing and fallback behavior.
- A pinned workflow is intentionally less portable, and changing the pin
  changes its checksum.
- Active runs remain pinned to the exact compiled harness choice.
