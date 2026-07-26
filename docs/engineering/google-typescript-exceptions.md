# Kairo exceptions to the Google TypeScript Style Guide

Kairo follows the Google TypeScript Style Guide as a baseline, not as an
unmodified external dependency.

## `const enum`

Kairo permits `const enum` for internal discriminants compiled and versioned
together.

Do not expose a `const enum` as a runtime value or rely on it across separately
versioned plugin packages. Numeric discriminants persisted in events, stored in
the database, or returned through APIs must use explicit stable values.

## Default exports

Named exports are the default.

A default export is allowed only when required or strongly expected by a file
convention, including:

- `oxfmt.config.ts`
- `oxlint.config.ts`
- Framework configuration files
- The single entrypoint of an ADW source package

## Result-based expected failures

Kairo uses `@usersatoshi/results` and package-owned discriminated error unions
for expected failures. This convention takes precedence over examples that use
exceptions for ordinary operational failures.

The `toErr` and `to<Domain>Error` constructors use a discriminant generic with
mapped details so each call retains its exact error variant. Their
implementations contain narrowly suppressed type assertions because TypeScript
cannot prove the relationship already enforced by the generic signatures.

Narrow assertions are also permitted where trusted ADW modules have been
structurally validated, where domain interfaces are passed to canonical JSON
serialization, and in tests that deliberately construct malformed data. Each
site must state the invariant or testing reason next to the suppression.

## Formatting width

Kairo uses a 100-column formatter target to avoid excessive wrapping in typed
workflow definitions and error unions.
