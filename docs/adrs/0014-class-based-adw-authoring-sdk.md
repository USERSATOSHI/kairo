# ADR-0014 — Class-based ADW authoring SDK

- Status: Accepted
- Date: 2026-07-26

## Context

The original ADW SDK exposed `defineWorkflow`, `node`, and `on` helpers around a
single object literal. That representation matches the compiler input, but it
does not model the relationships between declared nodes, transitions, counters,
and the workflow entry point. Authors must repeat string identifiers and can
construct locally incomplete definitions before the deterministic compiler
reports them.

Workflow authoring is an incremental process with meaningful mutable state:
declarations establish handles, transition chains remain incomplete until they
receive a target, and exactly one entry node must be selected. The compiled
workflow and runtime state do not share those characteristics.

## Decision

`@kouro/adw` exposes a `WorkflowBuilder` that owns mutable authoring state.
Node and counter declarations return handles associated with that builder.
Transitions are expressed through fluent handle operations, and `build()`
returns the existing immutable, data-only `WorkflowAuthoringDefinition`.

The builder fails immediately for mistakes it can identify from its local
state: duplicate node or counter names, foreign handles, duplicate entry
assignment, incomplete transition chains, and a missing entry. The
deterministic compiler remains the single source of truth for graph-wide
validation, canonical serialization, checksums, and compiled semantics.

Expressions remain plain immutable data produced by pure helpers. Node payloads,
the authoring definition, compiler inputs, and compiled bundles also remain
plain data. Runtime and compiler packages never receive builder or handle
instances.

The SDK exposes constants and literal unions for Kouro's built-in harness IDs,
normalized capabilities, and recovery policies. Harness-keyed capability and
model maps encode dependent authoring fields: a pinned agent may configure a
model only for its selected harness, while an unpinned agent may configure
models for any built-in fallback harness. These constraints apply only to the
TypeScript authoring boundary; the compiled data representation is unchanged.

The previous `defineWorkflow`, `node`, and `on` exports are removed without a
compatibility layer. This is an intentional source-level SDK break with no
compiled-format migration.

## Alternatives considered

### Runtime State pattern

Applying a State pattern to workflow execution would mix authoring ergonomics
with durable runtime orchestration. Runtime state is reconstructed from ordered
events and must remain plain, deterministic data, so runtime state objects are
not introduced.

### Workflow and node subclass hierarchy

Subclasses for workflow or node kinds would move data contracts and compiler
passes toward virtual behavior and runtime type identity. The four node kinds
are closed data variants with no polymorphic behavior, so discriminated plain
objects remain simpler and easier to serialize.

### Preserve the object helpers

Keeping the old helpers alongside the builder would create two public authoring
models and prolong repeated string references. The SDK redesign is intentionally
breaking, so the old surface is removed immediately.

## Consequences

- ADWs gain typed node and counter references and fluent transition authoring.
- Known protocol values and harness-dependent model configuration are checked
  while authoring instead of being guessed from unconstrained strings.
- Complete-node handles cannot declare transitions at compile time.
- Builder ownership mistakes and incomplete authoring fail close to their
  source.
- Existing manifests, resources, canonical bytes, checksums, persisted
  workflows, compiler errors, and runtime behavior remain compatible.
- Authors must migrate source definitions to `WorkflowBuilder`.
