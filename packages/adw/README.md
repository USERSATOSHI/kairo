# `@kouro/adw` — Authoring SDK and deterministic compiler

`@kouro/adw` provides the class-based TypeScript SDK for authoring Agent
Development Workflows and the deterministic compiler that turns their plain
definitions into canonical, checksummed runtime bundles.

## Architecture

```text
WorkflowBuilder
  -> build(): WorkflowAuthoringDefinition (plain data)
  -> compileAdwPackage(directory) (manifest and resource loading)
  -> compileWorkflow(source) (pure validation and normalization)
  -> CompiledWorkflowArtifact (bundle, canonical JSON, checksum)
```

Only `WorkflowBuilder` owns mutable authoring state. Handles, expressions, the
built definition, compiler inputs, and compiled artifacts carry data; builder
instances never cross into the compiler or runtime.

## Authoring a workflow

```typescript
import { all, output, WorkflowBuilder } from '@kouro/adw';

const workflow = new WorkflowBuilder({
  id: 'feature-development',
  version: '1.0.0',
});

workflow.permissions(
  'repository.read',
  'repository.write',
  'terminal.execute',
);
workflow.runLimits({
  maxDurationMs: 8 * 60 * 60 * 1000,
  maxNodeInvocations: 30,
});
workflow.subworkflow('validation', {
  package: '../shared-validation',
  version: '1.0.0',
});

const testRepairs = workflow.counter('testRepair', 3);
const reviewRepairs = workflow.counter('reviewRepair', 2);
const plan = workflow.agent('plan', {
  role: 'planner',
  prompt: './prompts/plan.md',
  outputSchema: './schemas/plan.schema.ts',
  capabilities: ['repository.read'],
  recoveryPolicy: 'resume_supported',
});
const approval = workflow.approval('planApproval', {
  title: 'Approve implementation plan',
});
const implement = workflow.agent('implement', {
  role: 'implementer',
  prompt: './prompts/implement.md',
  capabilities: ['repository.read', 'repository.write'],
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
  harness: 'codex',
  models: {
    codex: 'gpt-5.2-codex',
  },
  capabilities: ['repository.read'],
  recoveryPolicy: 'resume_supported',
});
const delivery = workflow.deliveryReview('delivery', {
  title: 'Review exact delivery',
  proposalFrom: 'review',
});
const complete = workflow.complete('complete');
const failed = workflow.complete('failed', { result: 'failed' });

workflow.startAt(plan);
plan.on('success').to(approval);
approval.on('approved').to(implement);
approval.on('rejected').to(failed);
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
review.on('success').when(output('approved').equals(true)).to(delivery);
delivery.on('approved').to(complete);

export default workflow.build();
```

The five declaration methods are `agent`, `approval`, `deliveryReview`,
`command`, and `complete`. The first four return transition-capable handles. A complete-node
handle has no `on` method, so terminal transitions are rejected by TypeScript.

`deliveryReview` is the only authoring boundary that asks Kouro to prepare and
commit a reviewed tree. `proposalFrom` must name an agent node. A workflow
without this node completes without Kouro creating a commit or branch.

Repeated invocations of one agent node preserve its harness session by default
and receive the durable source-node output as workflow feedback. Add
`clearContext: true` to an agent config to force a fresh session for every graph
invocation.

Set `harness: 'codex'` when a workflow intentionally pins an agent node to one
harness. If `harness` is omitted, Kouro uses the node-specific CLI route and
then the CLI's default `--harness` policy. A workflow pin is included in the
compiled checksum and does not inherit CLI fallbacks.

Use `models` to select a model for each harness that may execute the node.
Kouro resolves the entry after selecting the harness, so fallback harnesses can
use different provider-specific model identifiers. The map is included in the
compiled checksum. If the selected harness has no entry, the harness uses its
configured default.

`startAt(handle)` assigns the single entry node. `build()` returns the existing
`WorkflowAuthoringDefinition`; it does not compile the workflow.

## Transitions and expressions

Transitions start from a non-terminal node handle:

```typescript
source.on('success').to(target);
source.on('failure').when(condition).to(repair);
source.on('failure').otherwise().to(failed);
source.on('failure').when(counter.belowLimit()).increment(counter).to(repair);
```

Expression helpers emit the existing versioned expression data:

- `output(...path).equals(value)`
- `counter.lessThan(value)` and `counter.atLeast(value)`
- `counter.belowLimit()` and `counter.atLimit()`
- `all(...expressions)`, `any(...expressions)`, and `not(expression)`

Conditions observe a counter before the selected transition increments it.
Every graph cycle still requires an effective compiler-validated bound.

## Fail-fast authoring errors

`WorkflowBuilder` throws `WorkflowAuthoringError` for local state mistakes:

- duplicate node or counter names;
- node or counter handles owned by another builder;
- assigning the entry more than once;
- beginning a transition without completing it with `to`;
- building without an entry.

Graph-wide rules such as reachability, cycle bounds, duplicate transition
identities, permission declarations, and node configuration remain in the
deterministic compiler.

## ADW package structure

```text
my-workflow/
  manifest.json
  kouro.adw.ts
  prompts/
    implement.md
  schemas/
    change.schema.ts
```

Example manifest:

```json
{
  "id": "my-workflow",
  "name": "My Workflow",
  "version": "1.0.0",
  "kouro": "0.1.0",
  "entrypoint": "kouro.adw.ts",
  "permissions": ["repository.read", "repository.write"]
}
```

The entrypoint must default-export the result of `workflow.build()`. Agent
prompt and schema paths are resolved relative to the package directory.
Subworkflow packages are recursively compiled with package-cycle and exact
version checks.

## Compilation

```typescript
import { compileAdwPackage } from '@kouro/adw';

const result = await compileAdwPackage('./path/to/my-workflow');
if (result.isOk()) {
  const { bundle, canonical, checksum } = result.unwrap();
}
```

`compileWorkflow(source)` compiles an already assembled
`WorkflowSourceBundle`. Once resources are loaded, compilation is pure.
Canonical object keys, nodes, transitions, capabilities, and permissions are
ordered deterministically, producing byte-identical JSON and SHA-256 checksums
for the same workflow.

Compiler failures use
`Result<CompiledWorkflowArtifact, CompilerError>` from
`@usersatoshi/results`. Stable numeric `CompilerErrorKind` values cover invalid
manifests, resources, nodes, transitions, expressions, limits, permissions,
and subworkflows.

## Exported API

| Export | Kind |
|---|---|
| `WorkflowBuilder` | Stateful authoring builder |
| `WorkflowAuthoringError`, `WorkflowAuthoringErrorKind` | Fail-fast authoring errors |
| `output`, `all`, `any`, `not` | Pure expression helpers |
| Node, counter, and transition handle types | Fluent authoring contracts |
| `compileWorkflow` | Pure workflow compiler |
| `compileAdwPackage` | ADW package and resource compiler |
| `COMPILER_VERSION`, `IR_VERSION`, `EXPRESSION_VERSION` | Format versions |
| `CompilerErrorKind`, `CompilerError`, `toErr`, `toCompilerError` | Compiler errors |
| `canonicalJson`, `sha256`, `compareCanonicalText` | Canonicalization helpers |
