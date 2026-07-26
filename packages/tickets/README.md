# `@kairo/tickets`

Ticket planning domain, application services, declared persistence port, local
SQLite repository, and pure planning Kanban projection.

Tickets remain mutable planning aggregates. Active runs consume immutable
snapshots and are not mutated by this package.

Provider-neutral synchronization supports GitHub and capability-aware Forgejo
adapters. Webhook deliveries and polling both enter the same durable
reconciliation service.

`TicketMigrationService` moves a locally authoritative ticket to either remote
provider through persisted `prepared`, `remote_created`, `verified`, and
`completed` stages. A stable marker prevents duplicate creation after an
interruption. The ticket binding changes only after a remote read-back matches
the captured local revision.
