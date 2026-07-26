# AGENTS.md

## Purpose

These instructions apply to every human or coding agent modifying Kairo.

Kairo follows the Google TypeScript Style Guide where it is compatible with
the project's runtime, architecture, and tooling. Kairo-specific rules in this
file take precedence. Deliberate exceptions must be documented in
`docs/engineering/google-typescript-exceptions.md`.

The primary review standard is:

> Every change must preserve or improve the long-term health of the codebase.

## Required workflow

Before editing:

1. Read the nearest `AGENTS.md`.
2. Read relevant ADRs and package documentation.
3. Inspect existing code and tests before proposing a new abstraction.
4. State the invariant or behavior being changed.
5. Keep the change as small and self-contained as practical.

Before completion:

1. Run `bun run format`.
2. Run `bun run lint`.
3. Run `bun run typecheck`.
4. Run the relevant unit, contract, simulation, and integration tests.
5. Review the complete diff.
6. Remove debugging output, dead code, and unrelated edits.
7. Summarize design decisions, tests, risks, and intentionally deferred work.

Do not weaken checks or delete tests merely to make a change pass.

## Creating new packages

When creating a new package, run `bun run create-package <name>` from the project root. This creates the directory, `src/`, and a library-configured `package.json`.

## Architecture

Maintain this dependency direction:

```text
Transport
    ↓
Application
    ↓
Domain and runtime
    ↓
Declared ports

Infrastructure implements ports and is composed at the application boundary.
```

Rules:

- Domain and runtime modules must not import Elysia, React, SQLite adapters,
  concrete harnesses, or filesystem APIs.
- Elysia route handlers validate input, invoke one application use case, and
  map its `Result` into a transport response.
- Keep orchestration decisions pure and deterministic.
- Agents produce data. Agents do not schedule nodes, alter graph structure,
  change permissions, increase limits, or bypass approvals.
- External side effects must be explicit and declare a recovery policy.
- Active runs remain pinned to an exact compiled workflow checksum.
- Record architectural changes in an ADR before implementation.

## TypeScript

- Use ES modules and named exports.
- Default exports are allowed only where a framework or file convention
  requires them, such as tool configuration or an ADW entrypoint.
- Prefer function declarations for named, stateless operations.
- Use interfaces for object-shaped contracts and ports.
- Use type aliases for unions, tuples, mapped types, and type transformations.
- Use `unknown` instead of `any`, then narrow it.
- Avoid type assertions and non-null assertions. Document the invariant when
  an assertion is genuinely unavoidable.
- Add explicit return types to exported functions and public methods.
- Mark non-reassigned class fields and dependencies as `readonly`.
- Do not use `eval`, `Function(string)`, prototype mutation, or TypeScript
  namespaces.
- Do not create static utility or container classes for namespacing.
- Prefer composition over inheritance.
- Do not add speculative abstractions. Generalize only after the shared
  semantics are demonstrated by real call sites.
- Use JSDoc for public API behavior and ordinary comments for implementation
  reasoning. Comments explain why, not what the syntax already says.

## Classes versus functions

Classes are allowed and expected when they provide meaningful ownership.

Use a class when the object:

- Owns mutable state across operations.
- Owns a resource or lifecycle that must be initialized, closed, cancelled, or
  recovered.
- Enforces invariants across multiple methods.
- Implements a long-lived infrastructure port with injected dependencies.
- Represents a stateful coordinator, adapter, store, worker, or sandbox.

Typical Kairo classes include:

- `SqliteEventStore`
- `RunCoordinator`
- `LocalWorker`
- `WorktreeSandboxProvider`
- `ClaudeCodeHarness`
- `CodexHarness`

Use functions and plain immutable data when implementing:

- Compiler passes
- Schema validation
- Canonical serialization
- Event reduction
- Transition selection
- Scheduler decisions
- Recovery decisions
- Error construction
- Data mapping

Class rules:

- Inject dependencies through the constructor.
- Make injected dependencies `private readonly`.
- Keep constructors cheap and free of asynchronous work.
- Expose explicit lifecycle methods such as `initialize()` and `dispose()` when
  required.
- Keep fields stable after construction; do not add or remove properties
  dynamically.
- Avoid inheritance unless required by a framework. Prefer interfaces and
  composition.
- Prefer module-local functions over private static helper methods.
- Do not create classes containing only static methods.
- Do not turn plain data transfer objects into classes without behavior or
  invariants.

## Pure functions and function size

Prefer a functional core with an imperative shell.

Pure functions should contain:

- Workflow compilation
- Workflow validation
- Event reduction
- Transition selection
- Scheduler decisions
- Counter updates
- Recovery-policy decisions
- Canonical serialization
- Data transformation

The imperative shell may contain:

- Filesystem access
- SQLite transactions
- Git operations
- Subprocess execution
- Harness invocation
- Network calls
- Clocks and generated identifiers
- Logging and event publication

A pure function:

- Produces the same result for the same inputs.
- Does not read hidden mutable state.
- Does not mutate its inputs.
- Does not perform filesystem, database, network, subprocess, or logging
  operations.
- Receives clocks, identifiers, configuration, and external results as explicit
  inputs when they affect its result.

Prefer small and focused functions.

Function length is a review signal, not a mechanical correctness rule:

- Around 40 lines: review whether the function has multiple responsibilities.
- Around 60 lines: normally split the function unless keeping it intact makes
  the algorithm substantially clearer.
- Longer functions require a clear structural reason.
- Do not extract trivial one-use helpers merely to satisfy a line count.
- Do not split a cohesive algorithm into fragments that make control flow
  harder to understand.

Also consider:

- Number of responsibilities
- Nesting depth
- Number of local variables
- Number of branches
- Hidden state or side effects
- Whether the function can be tested independently
- Whether its name accurately describes everything it does

Prefer early returns over deeply nested control flow.

Extract a helper when it:

- Names a meaningful domain operation.
- Is independently testable.
- Removes a distinct responsibility.
- Reduces nesting or repeated logic.
- Makes the calling function read as a clear sequence of steps.

Do not extract a helper when it:

- Merely hides two or three obvious statements.
- Is used once and gives no meaningful name to the operation.
- Requires many parameters because it is tightly coupled to the caller.
- Makes readers jump between files to understand simple control flow.

## Error handling

Expected failures use `@usersatoshi/results`.

Each package or bounded domain owns:

- `<Domain>ErrorKind`
- `<Domain>Error`
- `toErr`
- `to<Domain>Error`

Rules:

- Use `fromAsync` to convert thrown infrastructure failures.
- Return `Result` from application, domain, executor, and persistence
  boundaries.
- Unexpected programming defects may throw.
- Do not use one global `KairoError` union.
- Persist only serializable errors.
- Numeric error kinds that cross a process, API, plugin, or persistence
  boundary must have explicit stable values.
- Never reuse a retired persisted error-kind value.
- Preserve useful causes internally, but redact secrets and serialize causes
  before durable storage or API exposure.

## Deterministic runtime rules

Kairo's determinism contract is:

> Given the same compiled workflow and ordered durable event history, Kairo
> reconstructs the same state and emits the same next orchestration decisions.

Maintain these distinctions:

- `NodeDefinition`: immutable node in the compiled workflow.
- `NodeInvocation`: one graph activation of a node definition.
- `NodeAttempt`: one retry or fallback attempt within an invocation.

Transition rules:

- A sequential invocation must select exactly one outgoing transition.
- Multiple matches are a typed failure.
- No match is a typed failure unless an explicit default exists.
- Transition declaration order must not affect behavior.
- Fan-out must be explicit.
- Loop counters increment only through declared transition metadata.
- Every cycle must have an explicit bound.
- Decision expressions use the versioned restricted expression language, never
  arbitrary JavaScript execution.

Do not claim exactly-once execution for arbitrary side effects. Every side
effect must use one recovery classification:

- `replay_safe`
- `verify_then_replay`
- `resume_supported`
- `manual_reconciliation`
- `never_automatically_retry`

## Persistence and artifacts

- Treat the append-only event stream as the audit and recovery record.
- Use projections for ordinary queries.
- Commit an event and its projection updates in one database transaction.
- Keep large logs, transcripts, patches, and reports outside the event stream.
- Write filesystem artifacts through a temporary file, checksum verification,
  and atomic rename before recording the durable artifact reference.
- Snapshot all decision-affecting configuration into the run.
- Pin the repository starting commit.
- Bind approvals to the workflow checksum, node invocation, relevant artifact
  checksums, requested action, and repository HEAD.
- A generic administrative skip is forbidden. Skipping requires workflow
  eligibility, authorization, a durable actor, and a reason.

## Performance

- Write the simplest correct implementation first.
- Do not optimize without a representative benchmark or profile.
- Do not add a cache without an invalidation strategy and evidence that it is
  needed.
- Use bounded concurrency and backpressure.
- Avoid full event replay for normal API reads.
- Avoid repeatedly parsing the same compiled bundle.
- Keep hot-path data structures explicit and simple.
- Include a benchmark when performance requirements justify additional
  complexity.
- Performance changes must preserve semantics and tests.

## Tests

Every behavior change requires tests at the lowest useful level.

- Pure runtime decisions require unit tests.
- Ports and adapters require reusable contract tests.
- Bug fixes require regression tests.
- Workflow behavior requires simulation tests.
- SQLite, Git, worktrees, and subprocess behavior require integration tests.
- Recovery changes must test interruption between the side effect and durable
  completion recording.
- Determinism tests must verify byte-stable compilation, reducer replay, and
  ordered scheduler decisions.
- Tests must not depend on execution order or shared mutable global state.

## Change scope and review

A change should solve one coherent problem.

Do not combine:

- Feature work with unrelated refactoring.
- Runtime semantics with UI work.
- Formatting churn with behavioral changes.
- New abstractions with speculative future features.

Every change description must explain:

- The problem
- Why the change is necessary
- The chosen design
- Alternatives considered
- Invariants affected
- Tests performed
- Performance impact
- Compatibility or migration impact
- Work intentionally excluded

Review in this order:

1. Product and architecture correctness
2. Runtime invariants
3. Functional correctness
4. Failure and recovery behavior
5. Tests
6. Complexity
7. Performance
8. Naming and documentation
9. Formatting
