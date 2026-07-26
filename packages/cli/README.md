# `@kairo/cli` — Local Kairo Host and Operator CLI

The CLI package provides a **runnable single-process Kairo host** with an operator command-line interface. It composes all infrastructure layers — persistence, sandbox, harnesses, and HTTP API — into a stand-alone application that can run workflows locally.

## Quick Start

Install the root package directly from GitHub:

```bash
npm install --global github:usersatoshi/kairo
kairo --help
```

The installed executable requires Bun. The repository and published package
ship a self-contained bundle, while these workspace dependencies remain for
development.

From a repository checkout:

```bash
# Create an ADW package from a starter template
bun run kairo create adw my-feature --template feature-development

# Run a feature development workflow
bun run kairo run feature-development --repo /path/to/repository \
  --task "Implement the requested change" --harness codex

# List all runs
bun run kairo runs

# Check run status
bun run kairo status <run-id>

# Approval operations
bun run kairo approve <run-id> <invocation> --reason "plan accepted"
bun run kairo reject <run-id> <invocation> --reason "changes needed"

# Lifecycle operations
bun run kairo pause <run-id>
bun run kairo resume <run-id>
bun run kairo cancel <run-id> --reason "abandoned"

# Invocation operations
bun run kairo interrupt <run-id> <invocation> --reason "taking too long"
bun run kairo retry <run-id> <invocation> --reason "transient error"
bun run kairo skip <run-id> <invocation> --reason "not applicable"

# Diagnostics
bun run kairo diagnostics

# Start HTTP API server (default port 4317)
bun run kairo serve [--port <number>]

# Help
bun run kairo --help
```

## Architecture

```
CLI (main.ts)
  │
  ▼ dispatches commands
LocalKairoHost (local-host.ts)
  ├── SqliteEventStore (persistence-sqlite)
  ├── WorktreeSandboxProvider (sandbox-worktree)
  ├── HarnessRegistry (harnesses)
  │   ├── CodexHarness
  │   ├── ClaudeCodeHarness
  │   ├── OpenCodeHarness
  │   └── PiHarness
  ├── LocalArtifactWriter (harnesses)
  ├── LocalWorker (worker.ts) — polling loop
  │   └── RunCoordinator (executors)
  └── createKairoApp (api)
       └── Elysia HTTP server
```

## Commands

### `kairo create adw <name> [--template <template>] [--output <directory>]`

Creates a compilable ADW package in `<directory>/<name>`. Names must be
lowercase kebab-case identifiers. The output directory defaults to `.kairo`
under the current directory, producing `.kairo/<name>`. The template defaults
to `feature-development`.

Available templates:

- `feature-development` — plan, approve, implement, and validate a feature
- `hotfix` — assess, implement, and validate an urgent correction
- `bug-fix` — reproduce, fix, and validate a defect
- `chore` — implement and validate a focused maintenance task

The command refuses to replace an existing folder.

### `kairo run <adw> --repo <path> <work-item> [--harness <id|node=id>]...`

Creates and executes a new run:

1. Compiles the ADW package (bundled `feature-development` or custom path)
2. Resolves and snapshots the work item
3. Registers the target Git repository
4. Pins the starting commit (`HEAD`)
5. Creates a Git worktree sandbox
6. Creates the run and advances it to its first stable boundary

The `<adw>` argument can be:
- `feature-development` — the bundled workflow
- A path to an ADW package directory

The built-in feature workflow requires exactly one work-item option:

- `--ticket <provider:reference>` resolves a configured ticket provider.
- `--task <text>` supplies an inline request.
- `--task-file <path>` reads a longer inline request.

The normalized work item is checksummed, persisted in durable run
configuration, and added to every agent prompt. Provider credentials are not
persisted.

An unqualified harness adds to the run's default ordered fallback policy.
Qualify repeated options with a compiled agent node ID to route different
agents independently:

```bash
bun run kairo run feature-development --repo /path/to/repository \
  --task "Implement the requested change" \
  --harness plan=claude-code \
  --harness implement=opencode \
  --harness review=codex
```

Repeating a node route defines its fallback order, for example
`--harness implement=opencode --harness implement=pi`.

An agent node's compiled `harness` field takes precedence over both forms of
CLI routing. Omit the field when operators should choose a harness or configure
fallbacks at run creation.

### `kairo serve [--port <number>]`

Starts the Kairo HTTP API server:
- API routes under `/api/`
- Static web assets from `../../web/dist`
- SPA fallback to `index.html`
- Default port: `4317`

### `kairo diagnostics`

Checks availability of agent harness binaries:
- `codex` — OpenAI Codex CLI
- `claude` — Anthropic Claude Code
- `opencode` — OpenCode CLI
- `pi` — Pi coding agent

## Local State (XDG Paths)

Paths follow the XDG Base Directory Specification:

| Path | Default | Override |
|------|---------|----------|
| Data directory | `~/.local/share/kairo` | `$KAIRO_DATA_DIR` / `$XDG_DATA_HOME/kairo` |
| Config directory | `~/.config/kairo` | `$KAIRO_CONFIG_DIR` / `$XDG_CONFIG_HOME/kairo` |
| Database | `<dataDir>/kairo.sqlite` | — |
| Artifacts | `<dataDir>/artifacts` | — |
| Worktrees | `<dataDir>/worktrees` | — |

## LocalKairoHost

The `LocalKairoHost` class is the **central orchestrator**:

```typescript
import { LocalKairoHost } from '@kairo/cli';

const host = new LocalKairoHost();
await host.initialize();

// Create a run
const { runId, status } = await host.create({
  adw: 'feature-development',
  repositoryPath: '/path/to/repo',
  task: 'Implement the requested change',
  harnesses: ['codex'],
  actor: 'user',
});

// Get the HTTP API app
const app = host.app();

// Start the server
await host.serve(4317);

// Clean up
await host.dispose();
```

### Lifecycle

1. **Initialization** (`initialize()`): Creates directories, boots SQLite, initializes the worktree sandbox, recovers previously running runs
2. **Run creation** (`create()`): Compiles ADW, registers repository, creates worktree, creates run, advances to first stable boundary
3. **Run advancement** (`LocalWorker`): Polling loop (250ms) that advances running runs to their next stable boundary
4. **Finalization** (`finalize()`): When a run reaches a terminal `complete` node with a successful result, captures git artifacts, commits changes, and creates a delivery branch `kairo/<run-id>`

## LocalWorker

The `LocalWorker` is a polling loop that advances runs:

```typescript
import { LocalWorker } from '@kairo/cli';

const worker = new LocalWorker(runServices);
await worker.recover();       // recover interrupted runs
worker.start();               // begin polling (250ms interval)
worker.runUntilStable(runId); // synchronously advance a run
worker.dispose();             // stop the loop
```

Features:
- **Recovery**: On startup, loads all running runs and runs `recoverRun()`
- **Stable boundary detection**: Stops advancing when a run reaches an approval gate or terminal state
- **Blocked run detection**: Skips runs that repeatedly encounter errors (avoids busy-looping)
- **Re-entrancy guard**: A `advancing` flag prevents concurrent ticks

## Bundled Workflow: `feature-development`

The CLI ships a pre-built ADW workflow for feature development:

```text
worktree → plan → planApproval → implement → validate → review
                                   ↑            │ failure  │ changes requested
                                   └────────────┴──────────┘
                                                ↓ approved
                                      deliveryApproval → complete
                                                ↓ rejected
                                              failed
```

Validation runs lint, format, and tests. Both validation failures (maximum 3)
and review change requests (maximum 2) return durable feedback to the same
context-preserving implementation agent. The workflow has 9 nodes, 14
transitions, and two human approval gates.

## Error Handling

| Error Kind | Code | Meaning |
|------------|------|---------|
| `InvalidArguments` | 0 | Bad CLI arguments |
| `Initialization` | 1 | Startup failure (SQLite, worktrees) |
| `Compilation` | 2 | ADW compilation failure |
| `Repository` | 3 | Git repo registration failure |
| `Persistence` | 4 | Run creation/store failure |
| `Lifecycle` | 5 | Run lifecycle operation failure |
| `Serve` | 6 | HTTP server startup failure |
| `HarnessUnavailable` | 7 | Agent harness not found |
| `Scaffolding` | 8 | ADW template creation failed |

## Exported API

| Export | Kind | Source |
|--------|------|--------|
| `LocalKairoHost` | class | `local-host.ts` |
| `LocalWorker` | class | `worker.ts` |
| `createLocalRequestHandler(app, webRoot)` | function | `local-host.ts` |
| `resolveLocalPaths(environment?)` | function | `paths.ts` |
| `CliError`, `CliErrorKind` | types | `errors.ts` |
| `WorkerRunServices` | interface | `worker.ts` |
| `LocalPaths` | interface | `paths.ts` |

## Dependencies

| Package | Purpose |
|---------|---------|
| `@kairo/adw` | ADW compilation |
| `@kairo/api` | HTTP API |
| `@kairo/api-contracts` | API DTOs |
| `@kairo/domain` | Domain types |
| `@kairo/executors` | RunCoordinator |
| `@kairo/harnesses` | CodexHarness, ClaudeCodeHarness, OpenCodeHarness, PiHarness |
| `@kairo/persistence-sqlite` | SqliteEventStore |
| `@kairo/sandbox-worktree` | WorktreeSandboxProvider |
| `@usersatoshi/results` | Result type |
