# ADR-0020 — Tickets are planning aggregates beside the runtime

- Status: Accepted
- Date: 2026-07-26

## Context

Kouro can already start a run from an immutable `WorkItemSnapshot`. That
snapshot deliberately prevents an external ticket edit from silently changing
an active run. Kouro does not yet own durable planning tickets, comments,
relationships, or a Kanban projection.

Local greenfield planning must work before a Git repository exists. Later
provider integrations must preserve Kouro ticket identity without moving
provider behavior into the deterministic runtime.

## Decision

Add a ticket bounded domain beside the workflow runtime:

```text
Ticket transport
    ↓
Ticket application services
    ↓
Ticket domain and declared ports

Provider and persistence adapters implement the declared ports.
```

The mutable `Ticket` aggregate owns planning content, planning status, labels,
assignees, relationships, comments, and provider binding. It does not contain
workflow execution states.

The existing runtime-facing `WorkItemSnapshot` remains the immutable input to a
run. T2 will translate a ticket revision into a ticket snapshot and then invoke
the existing run-start application service. The runtime never reads mutable
ticket rows.

For T1:

- `@kouro/tickets` contains the ticket domain, application services, repository
  port, SQLite adapter, and pure planning-board projection.
- `@kouro/ticket-provider-local` implements the provider-facing local adapter
  without Git, network, remote repository, or credential dependencies.
- SQLite is authoritative for local tickets.
- ticket changes use optimistic revisions so stale writes fail explicitly.
- relationships are stored once in their declared direction; inverse display
  is a projection concern.
- deleting planning history is excluded. Cancellation is the durable terminal
  planning action.

GitHub, Forgejo, provider synchronization, run links, migration, HTTP routes,
and UI are separate milestones.

## Consequences

- Local tickets and planning Kanban work in an empty directory.
- Stable Kouro ticket IDs are independent of provider bindings.
- Planning status cannot bypass runtime approvals or transitions.
- Provider adapters can be added without changing the ticket aggregate.
- T1 introduces a SQLite adapter in the ticket package to keep the first
  implementation small; it may move to a dedicated package if it gains an
  independent lifecycle or reuse boundary.
