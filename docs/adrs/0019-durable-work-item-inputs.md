# ADR-0019 — Runs bind an immutable work-item snapshot

- Status: Accepted
- Date: 2026-07-26

## Context

The feature-development workflow currently receives a repository and harness
policy, but no requested change. Its planner prompt refers to a requested
change that is never supplied.

Operators commonly start engineering work from a kanban ticket. Allowing an
agent to fetch that ticket itself would make the objective depend on ambient
credentials, provider-specific tools, and mutable external state. Refetching a
ticket after restart could also change the objective of an active run.

## Decision

Run creation accepts exactly one work-item source:

- `task`: inline task text, including text read by the CLI from `--task-file`.
- `ticket`: a source-qualified external ticket reference resolved through a
  configured `TicketProvider`.

Ticket providers are infrastructure adapters behind a provider-neutral port.
They return normalized ticket data and never expose credentials to workflows or
agents.

Before repository registration or worktree creation, Kouro resolves and
normalizes the input into a versioned `WorkItemSnapshot` containing:

- kind and source provider;
- source reference, revision, and URL when available;
- title and description;
- acceptance criteria and labels;
- a checksum over the normalized content.

The complete snapshot is stored in `run.created.configuration`. Large external
attachments are not embedded in the event and will be published as
checksum-bearing artifacts when provider adapters support them.

Every agent prompt receives the same serialized snapshot. Workflow feedback is
appended separately and cannot replace the original objective. Restart and
resume use the recorded snapshot without refetching the provider.

The built-in feature-development workflow requires a work item. Custom
workflows may omit one until workflow-declared input schemas are introduced.

## Consequences

- A feature-development agent always knows the requested change and acceptance
  criteria.
- Editing an external ticket cannot silently alter an active run.
- Provider-specific authentication and APIs remain outside workflow,
  application, domain, and runtime code.
- Run creation fails before repository side effects when input resolution
  fails.
- Inline tasks and provider-backed tickets follow the same execution path.
- A concrete kanban adapter must be configured before `--ticket` can resolve
  that provider's references.
