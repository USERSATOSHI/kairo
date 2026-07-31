# Kouro development and architecture guide

This document is for contributors and package consumers. For installation and
day-to-day CLI usage, start with the [user guide](../README.md).

## Development setup

Kouro is a Bun and TypeScript monorepo.

```bash
git clone <repository-url>
cd kouro
bun install
```

Run the CLI from source:

```bash
bun run kouro --help
bun run kouro diagnostics
bun run kouro sandbox status
bun run kouro run feature-development \
  --repo /path/to/repository \
  --task "Implement the requested change" \
  --harness codex
```

The built-in feature workflow requires exactly one of `--ticket`, `--task`, or
`--task-file`. Ticket references use `<provider>:<reference>` and are resolved
to an immutable snapshot before repository side effects begin.

Agent nodes can pin a model for each harness they may use:

```typescript
workflow.agent('implement', {
  role: 'implementer',
  prompt: './prompts/implement.md',
  models: {
    codex: 'gpt-5.2-codex',
    opencode: 'openai/gpt-5.2',
  },
  capabilities: ['repository.read', 'repository.write'],
  recoveryPolicy: 'resume_supported',
});
```

The compiler includes this map in the workflow checksum. At execution time the
coordinator resolves the model after selecting the harness, records it on the
durable attempt, and reuses it when resuming that attempt.

Link the package-based root CLI:

```bash
bun link
kouro --version
```

The root `kouro` package is a small Bun launcher for the published
`@kouro/cli` package. The CLI resolves its normal `@kouro/*` dependencies at
runtime rather than embedding them into a generated bundle.

## Required validation

Before completing a change, run:

```bash
bun run format
bun run lint
bun run typecheck
bun test
```

Check the root distribution archive:

```bash
bun pm pack --dry-run --ignore-scripts
```

Each independently distributed workspace includes its own `LICENSE` and
`"license": "Apache-2.0"` metadata.

## Workspace map

| Package | Responsibility |
| --- | --- |
| `@kouro/domain` | Immutable domain types and durable event contracts |
| `@kouro/adw` | ADW authoring SDK, package loading, validation, and deterministic compilation |
| `@kouro/runtime` | Pure reduction, transition selection, scheduling, simulation, and recovery decisions |
| `@kouro/executors` | Application coordination and execution ports |
| `@kouro/persistence-sqlite` | Transactional event history and query projections |
| `@kouro/sandbox-worktree` | Git worktrees, artifacts, path guards, and cross-platform provider-tool isolation |
| `@kouro/harnesses` | Claude Code, Codex, OpenCode, and Pi adapters |
| `@kouro/api-contracts` | Transport DTOs and shared API contracts |
| `@kouro/api` | Elysia application boundary and use cases |
| `@kouro/web` | Read-only execution console and approval controls |
| `@kouro/cli` | Local composition root, worker, HTTP host, and operator CLI |

## Dependency direction

Kouro maintains this dependency direction:

```text
Transport
    ↓
Application
    ↓
Domain and runtime
    ↓
Declared ports
```

Infrastructure implements ports and is composed by `@kouro/cli`.

- Domain and runtime code does not import Elysia, React, SQLite adapters, Git
  adapters, concrete harnesses, or filesystem APIs.
- Route handlers validate input, invoke one application use case, and map its
  `Result` into a response.
- Workflow compilation, event reduction, transition selection, scheduling, and
  recovery decisions remain pure and deterministic.
- Filesystem, database, Git, subprocess, network, clock, and identifier work
  stays in the imperative shell.

See [AGENTS.md](../AGENTS.md) for the complete engineering rules.

## Determinism contract

Kouro's runtime guarantee is:

> Given the same compiled workflow and ordered durable event history, Kouro
> reconstructs the same state and emits the same next orchestration decisions.

Kouro does not claim that agents, shell commands, Git, filesystems, or networks
are deterministic. Their outcomes are recorded durably; orchestration decisions
over those outcomes are deterministic.

Important consequences:

- Active runs are pinned to an exact compiled workflow checksum.
- Sequential invocations select exactly one transition.
- Multiple transition matches and missing matches are typed failures.
- Cycles require explicit bounds.
- Agents produce data but cannot alter the graph, permissions, limits, or
  approval policy.
- Side effects declare a recovery classification rather than claiming
  exactly-once execution.

Read [invariants.md](invariants.md), [runtime-model.md](runtime-model.md), and
the [ADRs](adrs) before changing runtime semantics.

## Authoring an ADW with the SDK

The installed CLI templates use dependency-free data definitions so they work
outside this monorepo. Package consumers can use the typed authoring SDK:

```typescript
import { WorkflowBuilder } from '@kouro/adw';

const workflow = new WorkflowBuilder({
  id: 'feature-work',
  version: '1.0.0',
});

workflow.permissions(
  'repository.read',
  'repository.write',
  'terminal.execute',
);
workflow.runLimits({
  maxDurationMs: 4 * 60 * 60 * 1000,
  maxNodeInvocations: 12,
});

const implement = workflow.agent('implement', {
  role: 'implementer',
  prompt: './prompts/implement.md',
  capabilities: [
    'repository.read',
    'repository.write',
    'terminal.execute',
  ],
  recoveryPolicy: 'resume_supported',
});
const validate = workflow.command('validate', {
  command: 'bun run format && bun run lint && bun run typecheck && bun test',
  capabilities: ['repository.read', 'terminal.execute'],
  recoveryPolicy: 'replay_safe',
});
const complete = workflow.complete('complete');
const failed = workflow.complete('failed', { result: 'failed' });

workflow.startAt(implement);
implement.on('success').to(validate);
validate.on('success').to(complete);
validate.on('failure').to(failed);

export default workflow.build();
```

An ADW package contains:

```text
my-workflow/
  manifest.json
  kouro.adw.ts
  prompts/
  schemas/
```

Prompts and output schemas referenced by agent nodes are compiled into the
content-addressed workflow bundle. Declaration order does not decide transition
selection.

For a complete implementation, see the built-in
[`feature-development`](../packages/cli/assets/adws/feature-development)
workflow and the [`@kouro/adw` package guide](../packages/adw/README.md).

## Local composition

`@kouro/cli` owns the single-process local application:

```text
CLI and HTTP
    ↓
LocalKouroHost
    ├── SqliteEventStore
    ├── WorktreeSandboxProvider
    ├── HarnessRegistry
    ├── LocalArtifactWriter
    ├── LocalWorker
    └── Elysia API and web console
```

Initialization creates the XDG data directories, opens SQLite, initializes the
worktree provider, and recovers interrupted runs. The local worker advances
runs to stable boundaries. Successful terminal runs capture Git artifacts,
create a controlled commit, and expose a `kouro/<run-id>` delivery branch.

The local MVP is intentionally single-process. Separate workers, PostgreSQL,
remote isolation, automatic merge, and deployment remain deferred.

## Publishing packages

Kouro publishes all `@kouro/*` packages in dependency order, followed by the
thin root `kouro` launcher. `@kouro/cli` is the local composition package and
`@kouro/web` supplies the dashboard assets used by the CLI.

Configure the target registry token without committing it:

```bash
export KOURO_FORGEJO_TOKEN="..."
# Later, for the public npm registry:
export NPM_TOKEN="..."
```

Inspect every package without uploading:

```bash
bun run release:forgejo:dry-run
bun run release:npm:dry-run
```

Publish to the selected registry:

```bash
bun run release:forgejo
bun run release:npm
```

The release commands run formatting, linting, type checking, tests, and
production builds before publication. Registry selection and npm public access
are command-level release policy, so package manifests do not pin
`publishConfig` to one registry. Existing versions are tolerated to make a
partially completed release safe to rerun. Each release automatically increments
the shared patch version in the root and all workspace manifests, updates exact
internal dependency versions and `bun.lock`, then publishes that version. A dry
run previews the next version and restores the manifests and lockfile afterward.
Failed releases also restore these files, so the same version can be retried
safely with already-published packages tolerated.

## Project status

Milestones M1 through M7 and ticket milestones T1 through T5 are accepted:

- deterministic compiler, reducer, scheduler, transitions, loops, and recovery;
- durable SQLite runtime and approval execution;
- Git worktree isolation and recovery;
- provider-neutral agent harness execution;
- bounded feature-development workflow;
- HTTP API and execution console;
- distributable local CLI and worker composition;
- local ticket planning, immutable run snapshots, GitHub/Forgejo issue
  synchronization, and resumable local-to-remote migration.

The detailed acceptance evidence lives under [milestones](milestones). Future
scope and explicit exclusions live in [the implementation plan](../plan.md) and
[TODO](../TODO.md).

## Architectural changes

Record architecture changes in an ADR before implementation. A behavior change
should also update the lowest useful test level:

- pure decisions: unit or simulation tests;
- ports and adapters: reusable contract tests;
- SQLite, Git, worktrees, and subprocesses: integration tests;
- recovery behavior: interruption tests around the side effect and durable
  completion boundary;
- determinism: byte-stable compilation, replay, and ordered-decision tests.
