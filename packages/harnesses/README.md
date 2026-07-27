# `@kouro/harnesses` — Agent Harness and Artifact Writer Implementations

Infrastructure implementations of the normalized agent-harness and artifact writer ports declared in `@kouro/executors`. Bridges Kouro's workflow orchestration with real-world AI coding agents (Claude Code, OpenAI Codex CLI, OpenCode, and Pi) and filesystem artifact storage.

## Architecture

```
Application layer (executors)
    ↓ declares port interfaces
AgentHarness | AgentHarnessRegistry | ArtifactWriter
    ↓
@kouro/harnesses (infrastructure implementations)
  ├── ClaudeCodeHarness — wraps the `claude` CLI
  ├── CodexHarness — wraps the `codex` CLI
  ├── OpenCodeHarness — wraps the `opencode` CLI
  ├── PiHarness — wraps the `pi` CLI
  ├── ScriptedFakeHarness — test double for scripted results
  ├── HarnessRegistry — in-memory harness registry
  ├── LocalArtifactWriter — filesystem artifact persistence
  ├── LocalInvocationActivityStore — cross-process best-effort live transcript observation
  └── BunProcessRunner — subprocess execution via Bun.spawn
```

## Agent Harnesses

### ClaudeCodeHarness

Wraps Anthropic's `claude` CLI tool (Claude Code):

```typescript
import { ClaudeCodeHarness } from '@kouro/harnesses';

const harness = new ClaudeCodeHarness();
// or with a custom process runner:
const harness = new ClaudeCodeHarness(new BunProcessRunner());
```

**Execution model:**
- **`execute()`**: Generates a fresh UUID session token, invokes `claude -p --output-format json --session-id <uuid> --permission-mode dontAsk --tools <tools> <prompt>`
- **`resume()`**: Invokes `claude -p --resume <token> --output-format json --permission-mode dontAsk --tools <tools> <prompt>`
- If `outputSchema` is present, passes `--json-schema <schema-json>` to Claude
- Parses the JSON result, extracting `structured_output` or `result`, and captures `session_id` as the resume token
- Maps capabilities to tools: write capabilities grant `Read,Glob,Grep,Edit,Write,Bash`; read-only grants `Read,Glob,Grep`

### CodexHarness

Wraps OpenAI's `codex` CLI tool (Codex CLI):

```typescript
import { CodexHarness } from '@kouro/harnesses';

const harness = new CodexHarness();
```

**Execution model:**
- **`execute()`**: Invokes `codex exec --json -s <sandbox> -- <prompt>`
- **`resume()`**: Invokes `codex exec resume --json <token> <prompt>`
- If `outputSchema` is present, writes the schema to a temp file and passes `--output-schema <path>`
- Parses output as JSONL, looking for `thread.started` (to capture `thread_id` as resume token) and `item.completed` with `item.type === 'agent_message'` (to capture final text)
- Maps capabilities to sandbox mode: `workspace-write` or `read-only`

Kouro may call `resume()` for a later graph invocation of the same agent node,
not only for interruption recovery. The durable session token retains the
agent's engineering context; `clearContext: true` on the node forces
`execute()` instead.

### OpenCodeHarness

Runs `opencode run --format json --pure`, captures the session ID and final text
event, and resumes with `--session <token>`. Read-only capabilities select
OpenCode's `plan` agent; write or command capabilities select `build`. Schemas
are included in the normalized prompt and independently validated by Kouro.

### PiHarness

Runs Pi in JSON mode with an exact session ID, project instructions enabled,
and project extensions and optional resources disabled. It resumes with
`--session <token>`. Pi's built-in tool allowlist is derived from declared
capabilities: read tools are always present, edit/write require a write
capability, and Bash requires an execute capability. Schemas are included in
the normalized prompt and independently validated by Kouro.

### ScriptedFakeHarness

Test double that returns pre-scripted results:

```typescript
import { ScriptedFakeHarness, processFailure } from '@kouro/harnesses';
import { err } from '@usersatoshi/results';

const fake = new ScriptedFakeHarness('test-harness', [
  { output: { summary: 'done' }, transcript: '...' },  // First call succeeds
  err(processFailure('something broke')),                // Second call fails
  { output: { summary: 'retry' }, transcript: '...', resumeToken: 'abc' },  // Third call
]);

const result = await fake.execute(request);
console.log(fake.calls); // Inspect recorded calls for assertions
```

All recorded calls are stored in `fake.calls` as `RecordedHarnessCall[]` arrays.

## HarnessRegistry

In-memory registry mapping harness IDs to harness instances:

```typescript
import {
  ClaudeCodeHarness,
  CodexHarness,
  HarnessRegistry,
  OpenCodeHarness,
  PiHarness,
} from '@kouro/harnesses';

const registry = new HarnessRegistry([
  new ClaudeCodeHarness(),
  new CodexHarness(),
  new OpenCodeHarness(),
  new PiHarness(),
]);

const harness = registry.get('codex');
if (harness.isOk()) {
  // Use the harness
}
```

Validates uniqueness and non-empty IDs at construction time. Returns `HarnessErrorKind.Unavailable` for unknown harness IDs.

## LocalArtifactWriter

Persists artifacts to the local filesystem with checksum verification:

```typescript
import { LocalArtifactWriter } from '@kouro/harnesses';

const writer = new LocalArtifactWriter('/path/to/artifacts');

const result = await writer.write({
  runId: 'run-abc',
  invocationSequence: 1,
  attemptNumber: 1,
  kind: 'agent_output',
  mediaType: 'application/json',
  content: JSON.stringify({ result: 'success' }),
});
```

**Storage layout:**

```
<root>/<sha256(runId)>/<invocationSequence>/<attemptNumber>/<kind>.<ext>
```

| Kind | Extension |
|------|-----------|
| `agent_output` | `.json` |
| `command_output` | `.json` |
| `harness_transcript` | `.ndjson` |
| `git_diff` | `.diff` |
| `git_status` | `.txt` |

**Features:**
- Write-via-temp-file + atomic link pattern (prevents partial writes)
- Idempotent: if content matches existing file, succeeds; if different, fails with error
- Returns `ArtifactReference` with checksum (`sha256:...`), size, and a composite ID

## ProcessRunner

Port interface and Bun implementation for subprocess execution:

```typescript
import { BunProcessRunner } from '@kouro/harnesses';

const runner = new BunProcessRunner();
const result = await runner.run('claude', ['-p', 'hello'], '/tmp');
// Returns { exitCode: 0, stdout: '...', stderr: '' }
```

The runner can also copy decoded stdout chunks to an optional observer while
still returning the complete stdout transcript. The executor isolates observer
failures so presentation cannot alter attempt execution.

## Execution Flow

The typical flow through the harness system:

```
AgentExecutor.execute()  (from @kouro/executors)
  │
  ├── HarnessRegistry.get(harnessId) → AgentHarness
  │
  ├── selected AgentHarness.execute(request) or resume(request, token)
  │     │
  │     └── BunProcessRunner.run(provider command, args, cwd)
  │           │
  │           └── Bun.spawn → parse output → HarnessExecution
  │
  ├── validateStructuredOutput(output, schema)
  │
  └── LocalArtifactWriter.write(request) × 2 (transcript + output)
        │
        └── Atomic filesystem write → ArtifactReference
```

When `HarnessExecutionRequest.model` is set, each adapter passes an explicit
model option to its CLI:

- Claude Code: `--model <model>`
- Codex: `--model <model>`
- OpenCode: `--model <provider/model>`
- Pi: `--model <provider/model>`

The same option is used for fresh and resumed execution. When `model` is
omitted, the adapter leaves model selection to the CLI.

## Exported API

| Export | Kind | Source |
|--------|------|--------|
| `ClaudeCodeHarness` | class | `claude-code-harness.ts` |
| `CodexHarness` | class | `codex-harness.ts` |
| `OpenCodeHarness` | class | `opencode-harness.ts` |
| `PiHarness` | class | `pi-harness.ts` |
| `ScriptedFakeHarness` | class | `scripted-fake-harness.ts` |
| `HarnessRegistry` | class | `registry.ts` |
| `LocalArtifactWriter` | class | `local-artifact-writer.ts` |
| `BunProcessRunner` | class | `process-runner.ts` |
| `ProcessOutput` | interface | `process-runner.ts` |
| `ProcessRunner` | interface | `process-runner.ts` |
| `ScriptedHarnessResult` | type | `scripted-fake-harness.ts` |
| `RecordedHarnessCall` | interface | `scripted-fake-harness.ts` |
| `processFailure`, `invalidResponse` | functions | `errors.ts` |

## Dependencies

| Package | Purpose |
|---------|---------|
| `@kouro/executors` | Port interfaces (`AgentHarness`, `HarnessRegistry`, etc.) |
| `@kouro/domain` | `ArtifactReference` type |
| `@usersatoshi/results` | `Result<T, E>` type |
