# ADR-0025 — Kouro replaces the Kairo product identity

- Status: Accepted
- Date: 2026-07-27

## Context

The project, CLI, workspace package scope, local storage, workflow package
metadata, delivery branches, and ticket integration markers all used the Kairo
name. The product is now named Kouro and newly created identities must not mix
the two names.

Some old names are inputs to durable or operator-owned state. Existing
installations can still have `KAIRO_*` environment variables, ADW manifests
with a `kairo` compatibility field, `kairo:<ticket-id>` references, provider
labels, migration markers, and default XDG directories. Treating those inputs
as invalid immediately would make existing runs and tickets appear lost after
an otherwise cosmetic rename.

## Decision

Kouro is the only identity written by new code:

- the executable and root package are `kouro`;
- workspace packages use the `@kouro/*` scope;
- TypeScript product identifiers use `Kouro`;
- ADW packages use `kouro.adw.ts` and a `kouro` manifest compatibility field;
- defaults use `.kouro`, `KOURO_*`, `kouro.sqlite`, and Kouro XDG directories;
- delivery branches, ticket references, labels, comments, and migration
  markers use the `kouro` namespace.

Read-time compatibility remains narrow and explicit:

- legacy `KAIRO_*` environment variables are fallback inputs when the matching
  `KOURO_*` variable is absent;
- the legacy default XDG directory is reused only when the Kouro directory
  does not exist;
- ADW manifests may provide legacy `kairo` when `kouro` is absent;
- local `kairo:<ticket-id>` references and existing Kairo provider labels and
  migration markers remain readable.

Compatibility inputs are normalized to Kouro before new workflow compilation
or external writes. The old `kairo` executable and `@kairo/*` package names are
not retained as aliases because the requested package and CLI identity change
must be unambiguous.

## Consequences

- Existing default local data remains visible after upgrading.
- Explicit legacy environment configuration continues to work while new
  documentation advertises only Kouro variables.
- Recompiling a legacy ADW produces Kouro metadata and therefore a new
  content-addressed workflow checksum.
- Consumers must update imports from `@kairo/*` to `@kouro/*` and invoke
  `kouro`.
- New successful runs create `kouro/<run-id>` delivery branches; existing
  `kairo/*` branches are not renamed or deleted.

## Alternatives considered

A blind textual rename was rejected because existing local databases and
provider-side identities would become undiscoverable. Keeping permanent aliases
for the old CLI and package scope was rejected because it would preserve two
public product identities indefinitely.
