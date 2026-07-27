# ADR 0026: Package-based CLI distribution

## Status

Accepted

## Context

The root `kouro` package previously shipped a generated bundle containing the
CLI and every workspace implementation. That made Git installation independent
of lifecycle scripts, but it hid the reusable `@kouro/*` packages behind one
large artifact. In particular, the local composition root was private even
though its public contracts are useful to Bun consumers.

## Decision

Publish `@kouro/cli` and `@kouro/web` alongside the existing public
`@kouro/*` packages. The root `kouro` package is now a thin Bun launcher whose
only runtime dependency is `@kouro/cli`. The CLI owns its templates and obtains
the dashboard assets from the installed `@kouro/web` package.

All packages continue to ship TypeScript source and require Bun. Internal
dependencies remain exact, release-versioned package dependencies.

## Consequences

- Consumers can install and import individual `@kouro/*` packages.
- The root package no longer contains a stale, duplicated implementation
  bundle.
- Installing from Git or a registry resolves the normal package dependency
  graph, so the package manager must install dependencies.
- Node-only execution is not supported; the CLI and package sources require
  Bun.
