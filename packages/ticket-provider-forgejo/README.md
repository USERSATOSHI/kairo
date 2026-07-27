# `@kouro/ticket-provider-forgejo`

Capability-aware Forgejo Issues adapter for Kouro tickets.

Each connection is configured with an instance URL, repository identity, and
credential. The adapter detects the instance version and advertised OpenAPI
surface, persists non-secret metadata when a metadata store is supplied, and
falls back to polling when issue webhooks are unavailable.
