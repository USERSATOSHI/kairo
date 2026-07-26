# Kairo

Kairo runs repeatable development workflows around coding agents, commands,
Git worktrees, and human approvals.

Give Kairo a workflow, a Git repository, and an installed coding-agent CLI. It
creates an isolated worktree, runs the declared steps, pauses when a decision
needs you, and produces a merge-ready `kairo/<run-id>` branch when the workflow
finishes successfully.

## Requirements

- [Bun](https://bun.sh/) 1.2 or newer
- Git
- At least one supported and authenticated coding-agent CLI:
  - `codex`
  - `claude`
  - `opencode`
  - `pi`

Kairo runs locally. Repository worktrees, run history, logs, and artifacts stay
on your machine.

## Install

Install directly from GitHub without cloning the repository:

```bash
npm install --global github:usersatoshi/kairo
```

Or install it globally with Bun:

```bash
bun add --global github:usersatoshi/kairo
```

Confirm that the command is available:

```bash
kairo --version
kairo --help
```

Kairo ships its executable bundle in the repository, so installation does not
depend on package lifecycle scripts being enabled.

To upgrade, run the same global installation command again. Uninstall with the
package manager you used:

```bash
npm uninstall --global kairo
bun remove --global kairo
```

## Quick start

First, check which agent harnesses Kairo can use:

```bash
kairo diagnostics
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
kairo run feature-development \
  --repo /path/to/your/repository \
  --harness codex
```

Kairo returns the new run ID and its current status:

```json
{
  "runId": "run-example",
  "status": "waiting_for_approval"
}
```

Keep the run ID. Use it to inspect and control the run:

```bash
kairo status run-example
kairo runs
```

When the workflow reaches an approval node, `status` shows the pending
invocation sequence. Approve the plan and let the workflow continue:

```bash
kairo approve run-example 3 --reason "Plan looks good"
```

The built-in workflow asks for approval twice:

1. Before implementation begins.
2. Before the completed changes are delivered.

After the final approval, Kairo creates a merge-ready branch named
`kairo/<run-id>` in the target repository. Kairo does not merge that branch for
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

Your original checkout is not used as the agent's working directory. Kairo
pins its current `HEAD` and creates a separate worktree under Kairo's data
directory.

## Choose agent harnesses

Use one harness for every unpinned agent node:

```bash
kairo run feature-development \
  --repo /path/to/repository \
  --harness codex
```

Route individual nodes to different harnesses:

```bash
kairo run feature-development \
  --repo /path/to/repository \
  --harness plan=claude-code \
  --harness implement=opencode \
  --harness review=codex
```

Repeat a route to define fallback order:

```bash
kairo run feature-development \
  --repo /path/to/repository \
  --harness implement=opencode \
  --harness implement=codex
```

If no `--harness` option is supplied, Kairo tries its default supported
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

Kairo selects the entry for the harness used by that attempt. This supports a
different model for each fallback harness. The selected model is included in
the compiled workflow checksum and durable attempt history, and resumed
sessions keep the same selection. If the selected harness has no entry, Kairo
leaves the model unset and that CLI uses its configured default.

## Create your own workflow

Create an editable ADW package in the current repository:

```bash
cd /path/to/your/repository
kairo create adw my-workflow --template feature-development
```

The default output is:

```text
.kairo/my-workflow/
  manifest.json
  kairo.adw.ts
  prompts/
```

Run it by passing its directory:

```bash
kairo run .kairo/my-workflow --repo . --harness codex
```

Available starter templates:

| Template | Intended use |
| --- | --- |
| `feature-development` | Plan, approve, implement, and validate a feature |
| `bug-fix` | Reproduce, fix, and validate a defect |
| `hotfix` | Assess, implement, and validate an urgent correction |
| `chore` | Implement and validate focused maintenance work |

Use `--output <directory>` to create the workflow somewhere other than
`.kairo`. Kairo refuses to overwrite an existing workflow directory.

## Run operations

### Inspect runs

```bash
kairo runs
kairo status <run-id>
```

### Decide approvals

```bash
kairo approve <run-id> <invocation> --reason "Approved"
kairo reject <run-id> <invocation> --reason "Needs a different approach"
```

### Control a run

```bash
kairo pause <run-id>
kairo resume <run-id>
kairo cancel <run-id> --reason "No longer needed"
```

Pausing is recoverable. Cancellation is terminal.

### Control an invocation

```bash
kairo interrupt <run-id> <invocation> --reason "Taking too long"
kairo retry <run-id> <invocation> --reason "Transient failure"
kairo skip <run-id> <invocation> --reason "Not applicable"
```

Skipping works only when the workflow explicitly declares that invocation as
eligible to skip.

## Web console and API

Start the local server:

```bash
kairo serve
```

Then open:

```text
http://localhost:4317
```

Choose a different port when needed:

```bash
kairo serve --port 8080
```

The server exposes the API under `/api/` and serves the bundled execution
console from the same address. Keep the process running while using the web
console.

## Local data

Kairo follows the XDG Base Directory Specification:

| Data | Default location | Override |
| --- | --- | --- |
| Database and run data | `~/.local/share/kairo` | `KAIRO_DATA_DIR` |
| Configuration | `~/.config/kairo` | `KAIRO_CONFIG_DIR` |
| Artifacts | `~/.local/share/kairo/artifacts` | Derived from data directory |
| Worktrees | `~/.local/share/kairo/worktrees` | Derived from data directory |

`XDG_DATA_HOME` and `XDG_CONFIG_HOME` are respected when the Kairo-specific
variables are not set.

Use a separate data directory for an isolated experiment:

```bash
KAIRO_DATA_DIR=/tmp/kairo-demo kairo runs
```

## Troubleshooting

### A harness is unavailable

Run:

```bash
kairo diagnostics
```

Install the missing agent CLI, authenticate it using that tool's normal login
flow, and retry with its Kairo harness ID. Note that the executable names and
harness IDs differ for Claude Code: the executable is `claude`, while the
harness ID is `claude-code`.

### Kairo is waiting for approval

Inspect the run:

```bash
kairo status <run-id>
```

Find the pending approval invocation sequence, then pass that number to
`kairo approve` or `kairo reject`.

### A repository cannot be registered

Confirm that the path is a Git repository with a valid `HEAD`:

```bash
git -C /path/to/repository rev-parse HEAD
```

Kairo pins that commit before creating its worktree. Uncommitted changes in
your existing checkout are not part of the pinned starting commit.

### Where are the completed changes?

Inspect the target repository's Kairo branches:

```bash
git -C /path/to/repository branch --list 'kairo/*'
```

The branch name for a successful run is `kairo/<run-id>`.

## Documentation

- [Development and architecture guide](docs/development.md)
- [Runtime model](docs/runtime-model.md)
- [Terminology](docs/terminology.md)
- [Runtime invariants](docs/invariants.md)
- [Product and implementation plan](plan.md)
- [Milestone acceptance records](docs/milestones)
- [Architecture decisions](docs/adrs)

Kairo is licensed under [Apache-2.0](LICENSE).
