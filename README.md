# Kairo

Kairo is a programmable, deterministic execution engine for Agent Development
Workflows (ADWs).

The runtime guarantee is:

> Given the same compiled workflow and ordered durable event history, Kairo
> reconstructs the same state and emits the same next orchestration decisions.

Kairo does not claim that agents, shell commands, Git, or filesystems are
deterministic. It makes orchestration and recovery decisions deterministic over
their recorded outcomes.

## Current status

M1 through M7 are complete:

- deterministic ADW compilation, event reduction, scheduling, transitions,
  bounded loops, approvals, and recovery decisions;
- transactional SQLite history and projections, command execution,
  idempotency, approvals, and restart recovery;
- registered and pinned repositories, isolated run worktrees, atomic Git
  artifacts, controlled commits, mutation coordination, cleanup, and recovery;
- provider-neutral agent execution through Claude Code, Codex, OpenCode, and
  Pi, independent structured-output validation, per-node harness routing,
  durable artifacts, fallback, and resume;
- a worktree-backed feature-development slice with planning and delivery
  approvals, bounded test and review repairs, deterministic run limits,
  read-only review, restart recovery, and artifact-bound delivery;
- an in-process-testable Elysia application boundary, typed contracts and Eden
  client, reconnectable durable event replay, checksum-verified artifact
  access, and a read-only React Flow execution console with approval controls;
- a distributable operator CLI, predictable XDG-compatible local paths,
  packaged feature-development ADW, startup-recovering worker, durable lifecycle
  controls, single-process API/web hosting, harness diagnostics, and controlled
  merge-ready branch delivery.

See [plan.md](plan.md), [M1](docs/milestones/m1.md),
[M2](docs/milestones/m2.md), [M3](docs/milestones/m3.md),
[M4](docs/milestones/m4.md), [M5](docs/milestones/m5.md), and
[M6](docs/milestones/m6.md), and [M7](docs/milestones/m7.md) acceptance records.

The local MVP is complete. Post-MVP integrations, parallel execution, remote
isolation, visual editing, merge automation, and deployment remain deferred.

## Install

Kairo requires [Bun](https://bun.sh/) at runtime. Install the CLI directly from
GitHub without cloning the repository:

```bash
npm install --global github:usersatoshi/kairo
kairo --help
```

The repository ships a self-contained CLI bundle, and Kairo's `prepare` script
refreshes it when lifecycle scripts are enabled. Package archives include the
same bundle. After publishing `kairo`, it can also be installed with:

```bash
npm install --global kairo
```

For development inside a checkout, build and link the root package:

```bash
bun run build:cli
bun link
```

## Development

Install dependencies:

```bash
bun install
```

Run the executable specifications:

```bash
bun test
```

Run the operator CLI:

```bash
bun run kairo --help
bun run kairo create adw my-feature --template feature-development
bun run kairo run feature-development --repo /path/to/repository --harness codex
bun run kairo run feature-development --repo /path/to/repository \
  --harness plan=claude-code \
  --harness implement=opencode \
  --harness review=codex
bun run kairo serve
```

Type-check the project:

```bash
bun run typecheck
```

## Authoring a feature-implementation workflow

The built-in
[`feature-development`](packages/cli/assets/adws/feature-development/kairo.adw.ts)
ADW is a complete example: it plans work, waits for plan approval, implements
the change, runs tests, performs bounded test repair, conducts a read-only
review, performs bounded review repair, waits for delivery approval, and
terminates through explicit success or failure nodes.

The core graph is authored with typed handles:

```typescript
import { all, output, WorkflowBuilder } from '@kairo/adw';

const workflow = new WorkflowBuilder({
  id: 'feature-development',
  version: '1.0.0',
});
workflow.permissions(
  'repository.read',
  'repository.write',
  'terminal.execute',
);

const testRepairs = workflow.counter('testRepair', 3);
const reviewRepairs = workflow.counter('reviewRepair', 2);
const plan = workflow.agent('plan', {
  role: 'planner',
  prompt: './prompts/plan.md',
  outputSchema: './schemas/plan.schema.ts',
  capabilities: ['repository.read'],
  recoveryPolicy: 'resume_supported',
});
const planApproval = workflow.approval('planApproval', {
  title: 'Approve implementation plan',
});
const implement = workflow.agent('implement', {
  role: 'implementer',
  prompt: './prompts/implement.md',
  outputSchema: './schemas/change.schema.ts',
  capabilities: ['repository.read', 'repository.write', 'terminal.execute'],
  recoveryPolicy: 'resume_supported',
});
const validate = workflow.command('validate', {
  command: 'bun run lint && bun run format && bun test',
  capabilities: ['repository.read', 'terminal.execute'],
  recoveryPolicy: 'replay_safe',
});
const review = workflow.agent('review', {
  role: 'reviewer',
  prompt: './prompts/review.md',
  outputSchema: './schemas/review.schema.ts',
  capabilities: ['repository.read'],
  recoveryPolicy: 'resume_supported',
});
const deliveryApproval = workflow.approval('deliveryApproval', {
  title: 'Approve merge-ready delivery',
});
const complete = workflow.complete('complete');
const failed = workflow.complete('failed', { result: 'failed' });

workflow.startAt(plan);
plan.on('success').to(planApproval);
planApproval.on('approved').to(implement);
planApproval.on('rejected').to(failed);
implement.on('success').to(validate);
validate.on('success').to(review);
validate
  .on('failure')
  .when(testRepairs.belowLimit())
  .increment(testRepairs)
  .to(implement);
validate.on('failure').when(testRepairs.atLimit()).to(failed);
review
  .on('success')
  .when(all(output('approved').equals(false), reviewRepairs.belowLimit()))
  .increment(reviewRepairs)
  .to(implement);
review
  .on('success')
  .when(all(output('approved').equals(false), reviewRepairs.atLimit()))
  .to(failed);
review.on('success').when(output('approved').equals(true)).to(deliveryApproval);
deliveryApproval.on('approved').to(complete);
deliveryApproval.on('rejected').to(failed);

export default workflow.build();
```

Repeated `implement` invocations resume the same harness session and receive
the durable validation or review output that caused the loop. Set
`clearContext: true` on an agent declaration when that agent should start a
fresh session on every graph invocation.

An agent declaration may also set `harness: 'codex'` to pin that node to one
harness. If omitted, Kairo resolves the node-specific CLI route first and then
the default `--harness` policy, including its ordered fallbacks.

Real workflows must include the prompt and schema resources named by their
agent nodes. The packaged example provides
[`prompts/`](packages/cli/assets/adws/feature-development/prompts) and
[`schemas/`](packages/cli/assets/adws/feature-development/schemas), plus a
matching
[`manifest.json`](packages/cli/assets/adws/feature-development/manifest.json).

Compile that package and print its content checksum:

```bash
bun -e "import {compileAdwPackage} from '@kairo/adw'; const result = await compileAdwPackage('packages/cli/assets/adws/feature-development'); if (result.isErr()) throw new Error(JSON.stringify(result.error)); console.log(result.unwrap().checksum);"
```
