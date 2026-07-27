# Kouro

Kouro runs repeatable development workflows around coding agents, commands,
Git worktrees, and human approvals.

Give Kouro a workflow, a Git repository, and an installed coding-agent CLI. It
creates an isolated worktree, runs the declared steps, pauses when a decision
needs you, and produces a merge-ready `kouro/<run-id>` branch when the workflow
finishes successfully.

## Requirements

- [Bun](https://bun.sh/) 1.2 or newer
- Git
- At least one supported and authenticated coding-agent CLI:
  - `codex`
  - `claude`
  - `opencode`
  - `pi`

Kouro runs locally. Repository worktrees, run history, logs, and artifacts stay
on your machine.

Kouro also contains the accepted T1–T6 ticket system: local greenfield
planning, immutable run snapshots, GitHub Issues synchronization, and
capability-aware Forgejo Issues synchronization, including resumable migration
from local authority to either remote provider. The local dashboard provides a
unified planning and execution Kanban with ticket histories and redacted
provider configuration status.

## Install

Install directly from GitHub without cloning the repository:

```bash
npm install --global github:usersatoshi/kouro
```

Or install it globally with Bun:

```bash
bun add --global github:usersatoshi/kouro
```

Confirm that the command is available:

```bash
kouro --version
kouro --help
```

Kouro installs its normal `@kouro/*` package dependency graph; the root
package is a small Bun launcher rather than an embedded implementation bundle.

To upgrade, run the same global installation command again. Uninstall with the
package manager you used:

```bash
npm uninstall --global kouro
bun remove --global kouro
```

## Quick start

First, check which agent harnesses Kouro can use:

```bash
kouro diagnostics
```

The result reports whether each supported CLI is available:

```json
[
  { "id": "codex", "available": true },
  { "id": "claude-code", "available": false },
  { "id": "opencode", "available": false },
  { "id": "pi", "available": false }
]
```

Run the built-in feature-development workflow against a Git repository:

```bash
kouro run feature-development \
  --repo /path/to/your/repository \
  --task "Add account export with tests" \
  --harness codex
```

For kanban-backed work, use a source-qualified ticket reference after
configuring that ticket provider:

```bash
kouro run feature-development \
  --repo /path/to/your/repository \
  --ticket kanban:ENG-123 \
  --harness codex
```

Kouro resolves the ticket before creating a worktree, stores an immutable
snapshot in the run, and gives the same objective and acceptance criteria to
every agent. Use `--task-file request.md` for longer standalone requests.

Kouro-owned planning tickets are usable through the CLI:

```bash
kouro ticket create --project personal \
  --title "Add CSV export" \
  --description "Export filtered results as CSV."
kouro ticket list --project personal
kouro run feature-development --repo /path/to/repository \
  --ticket kouro:<ticket-id> --harness codex
```

GitHub and Forgejo imports, synchronization, and local-to-remote migration are
composed from environment-only credentials. See
[`packages/cli/README.md`](packages/cli/README.md#kouro-ticket-) for setup and
command examples.

Kouro returns the new run ID and its current status:

```json
{
  "runId": "run-example",
  "status": "waiting_for_approval"
}
```

Keep the run ID. Use it to inspect and control the run:

```bash
kouro status run-example
kouro runs
```

When the workflow reaches an approval node, `status` shows the pending
invocation sequence. Approve the plan and let the workflow continue:

```bash
kouro approve run-example 3 --reason "Plan looks good"
```

The built-in workflow asks for approval twice:

1. Before implementation begins.
2. Before the completed changes are delivered.

After the final approval, Kouro creates a merge-ready branch named
`kouro/<run-id>` in the target repository. Kouro does not merge that branch for
you.

## What the built-in workflow does

The `feature-development` workflow runs this sequence:

```text
check repository
  -> plan with an agent
  -> wait for plan approval
  -> implement in an isolated worktree
  -> run validation
  -> review with an agent
  -> wait for delivery approval
  -> create a merge-ready branch
```

Validation failures can return to the implementation agent up to three times.
Review change requests can return to the same agent context up to two times.
Those bounds are part of the compiled workflow and cannot be increased by an
agent.

Your original checkout is not used as the agent's working directory. Kouro
pins its current `HEAD` and creates a separate worktree under Kouro's data
directory.

## Choose agent harnesses

Use one harness for every unpinned agent node:

```bash
kouro run feature-development \
  --repo /path/to/repository \
  --task "Implement the requested change" \
  --harness codex
```

Route individual nodes to different harnesses:

```bash
kouro run feature-development \
  --repo /path/to/repository \
  --task "Implement the requested change" \
  --harness plan=claude-code \
  --harness implement=opencode \
  --harness review=codex
```

Repeat a route to define fallback order:

```bash
kouro run feature-development \
  --repo /path/to/repository \
  --task "Implement the requested change" \
  --harness implement=opencode \
  --harness implement=codex
```

If no `--harness` option is supplied, Kouro tries its default supported
harness order. Supplying an explicit harness is recommended so a missing CLI
does not surprise you.

## Select models in a workflow

Model identifiers belong to the workflow because each harness uses its own
model namespace. Add a `models` map to an agent node:

```typescript
const implement = workflow.agent('implement', {
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

Kouro selects the entry for the harness used by that attempt. This supports a
different model for each fallback harness. The selected model is included in
the compiled workflow checksum and durable attempt history, and resumed
sessions keep the same selection. If the selected harness has no entry, Kouro
leaves the model unset and that CLI uses its configured default.

## Create your own workflow

Create an editable ADW package in the current repository:

```bash
cd /path/to/your/repository
bun add --dev @kouro/adw
kouro create adw my-workflow --template feature-development
```

The default output is:

```text
.kouro/my-workflow/
  manifest.json
  kouro.adw.ts
  prompts/
```

The entrypoint imports the fluent `WorkflowBuilder` API from `@kouro/adw`. Add
nodes with `workflow.agent`, `workflow.command`, `workflow.approval`, or
`workflow.complete`, then connect their handles with `node.on(...).to(...)`.

Run it by passing its directory:

```bash
kouro run .kouro/my-workflow --repo . --harness codex
```

Available starter templates:

| Template | Intended use |
| --- | --- |
| `feature-development` | Plan, approve, implement, and validate a feature |
| `bug-fix` | Reproduce, fix, and validate a defect |
| `hotfix` | Assess, implement, and validate an urgent correction |
| `chore` | Implement and validate focused maintenance work |

Use `--output <directory>` to create the workflow somewhere other than
`.kouro`. Kouro refuses to overwrite an existing workflow directory.

## Run operations

### Inspect runs

```bash
kouro runs
kouro status <run-id>
```

### Decide approvals

```bash
kouro approve <run-id> <invocation> --reason "Approved"
kouro reject <run-id> <invocation> --reason "Needs a different approach"
```

### Control a run

```bash
kouro pause <run-id>
kouro resume <run-id>
kouro cancel <run-id> --reason "No longer needed"
```

Pausing is recoverable. Cancellation is terminal.

### Control an invocation

```bash
kouro interrupt <run-id> <invocation> --reason "Taking too long"
kouro retry <run-id> <invocation> --reason "Transient failure"
kouro skip <run-id> <invocation> --reason "Not applicable"
```

Skipping works only when the workflow explicitly declares that invocation as
eligible to skip.

## Web console and API

Start the local server:

```bash
kouro serve
```

Then open:

```text
http://localhost:4317
```

Choose a different port when needed:

```bash
kouro serve --port 8080
```

The server exposes the API under `/api/` and serves the bundled execution
console from the same address. Keep the process running while using the web
console.

## Local data

Kouro follows the XDG Base Directory Specification:

| Data | Default location | Override |
| --- | --- | --- |
| Database and run data | `~/.local/share/kouro` | `KOURO_DATA_DIR` |
| Configuration | `~/.config/kouro` | `KOURO_CONFIG_DIR` |
| Artifacts | `~/.local/share/kouro/artifacts` | Derived from data directory |
| Worktrees | `~/.local/share/kouro/worktrees` | Derived from data directory |

`XDG_DATA_HOME` and `XDG_CONFIG_HOME` are respected when the Kouro-specific
variables are not set.

Use a separate data directory for an isolated experiment:

```bash
KOURO_DATA_DIR=/tmp/kouro-demo kouro runs
```

## Troubleshooting

### A harness is unavailable

Run:

```bash
kouro diagnostics
```

Install the missing agent CLI, authenticate it using that tool's normal login
flow, and retry with its Kouro harness ID. Note that the executable names and
harness IDs differ for Claude Code: the executable is `claude`, while the
harness ID is `claude-code`.

### Kouro is waiting for approval

Inspect the run:

```bash
kouro status <run-id>
```

Find the pending approval invocation sequence, then pass that number to
`kouro approve` or `kouro reject`.

### A repository cannot be registered

Confirm that the path is a Git repository with a valid `HEAD`:

```bash
git -C /path/to/repository rev-parse HEAD
```

Kouro pins that commit before creating its worktree. Uncommitted changes in
your existing checkout are not part of the pinned starting commit.

### Where are the completed changes?

Inspect the target repository's Kouro branches:

```bash
git -C /path/to/repository branch --list 'kouro/*'
```

The branch name for a successful run is `kouro/<run-id>`.

## Documentation

- [Development and architecture guide](docs/development.md)
- [Runtime model](docs/runtime-model.md)
- [Terminology](docs/terminology.md)
- [Runtime invariants](docs/invariants.md)
- [Product and implementation plan](plan.md)
- [Milestone acceptance records](docs/milestones)
- [Architecture decisions](docs/adrs)

Kouro is licensed under [Apache-2.0](LICENSE).
