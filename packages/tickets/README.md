# `@kairo/tickets`

Ticket planning domain, application services, declared persistence port, local
SQLite repository, and pure planning Kanban projection.

Tickets remain mutable planning aggregates. Active runs consume immutable
snapshots and are not mutated by this package.
