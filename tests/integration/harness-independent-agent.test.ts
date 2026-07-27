import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';

import { compileWorkflow } from '@kouro/adw';
import type { CompiledWorkflowArtifact, WorkflowSourceBundle } from '@kouro/domain';
import {
  AgentExecutor,
  ExecutorErrorKind,
  HarnessErrorKind,
  RunCoordinator,
  validateStructuredOutput,
  type AgentHarness,
  type CommandRunner,
  type CommandRunnerError,
} from '@kouro/executors';
import {
  BunProcessRunner,
  ClaudeCodeHarness,
  CodexHarness,
  HarnessRegistry,
  LocalArtifactWriter,
  OpenCodeHarness,
  PiHarness,
  ScriptedFakeHarness,
  type ProcessOutput,
  type ProcessRunner,
} from '@kouro/harnesses';
import { SqliteEventStore } from '@kouro/persistence-sqlite';
import { err, ok, type Result } from '@usersatoshi/results';

class UnusedCommandRunner implements CommandRunner {
  execute(): Promise<Result<never, CommandRunnerError>> {
    throw new Error('Command execution is not expected');
  }
}

class ScriptedProcessRunner implements ProcessRunner {
  readonly calls: {
    readonly command: string;
    readonly args: readonly string[];
    readonly workingDirectory: string;
  }[] = [];

  constructor(private readonly outputs: readonly ProcessOutput[]) {}

  run(
    command: string,
    args: readonly string[],
    workingDirectory: string,
  ): Promise<Result<ProcessOutput, never>> {
    this.calls.push({ command, args, workingDirectory });
    const output = this.outputs[this.calls.length - 1];
    if (!output) throw new Error(`No process result scripted for ${command}`);
    return Promise.resolve(ok(output));
  }
}

function artifact(
  additionalModels: Readonly<Record<string, string>> = {},
): CompiledWorkflowArtifact {
  const schemaPath = './schemas/plan.json';
  const source: WorkflowSourceBundle = {
    manifest: { id: 'm4-agent', version: '1.0.0' },
    semanticVersions: { compiler: '0.1.0', ir: '1', expressions: '1' },
    entryNodeId: 'plan',
    nodes: [
      {
        id: 'plan',
        type: 'agent',
        role: 'planner',
        prompt: './prompts/plan.md',
        outputSchema: schemaPath,
        capabilities: ['repository.read'],
        models: {
          'claude-code': 'claude-model',
          codex: 'codex-model',
          opencode: 'provider/opencode-model',
          pi: 'provider/pi-model',
          ...additionalModels,
        },
        recoveryPolicy: 'resume_supported',
      },
      { id: 'complete', type: 'complete' },
    ],
    transitions: [
      {
        id: 'plan.success.complete',
        from: { nodeId: 'plan', outcome: 'success' },
        toNodeId: 'complete',
      },
    ],
    counterLimits: {},
    prompts: {
      './prompts/plan.md': 'Return a concise implementation plan.',
    },
    schemas: {
      [schemaPath]: {
        type: 'object',
        additionalProperties: false,
        required: ['summary', 'steps'],
        properties: {
          summary: { type: 'string' },
          steps: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    permissions: ['repository.read'],
  };
  return compileWorkflow(source).unwrap();
}

function loopingAgentArtifact(clearContext: boolean): CompiledWorkflowArtifact {
  return compileWorkflow({
    manifest: { id: `context-${clearContext ? 'clear' : 'preserve'}`, version: '1.0.0' },
    semanticVersions: { compiler: '0.1.0', ir: '1', expressions: '1' },
    entryNodeId: 'implement',
    nodes: [
      {
        id: 'implement',
        type: 'agent',
        role: 'implementer',
        prompt: 'Implement or repair the change.',
        recoveryPolicy: 'resume_supported',
        ...(clearContext ? { clearContext: true } : {}),
      },
      { id: 'complete', type: 'complete' },
    ],
    transitions: [
      {
        id: 'implement.success.implement',
        from: { nodeId: 'implement', outcome: 'success' },
        toNodeId: 'implement',
        condition: {
          op: 'lt',
          left: { scope: 'counter', name: 'repairs' },
          right: 1,
        },
        increment: 'repairs',
      },
      {
        id: 'implement.success.complete',
        from: { nodeId: 'implement', outcome: 'success' },
        toNodeId: 'complete',
        condition: {
          op: 'gte',
          left: { scope: 'counter', name: 'repairs' },
          right: 1,
        },
      },
    ],
    counterLimits: { repairs: 1 },
  }).unwrap();
}

function routedAgentArtifact(): CompiledWorkflowArtifact {
  return compileWorkflow({
    manifest: { id: 'routed-agents', version: '1.0.0' },
    semanticVersions: { compiler: '0.1.0', ir: '1', expressions: '1' },
    entryNodeId: 'plan',
    nodes: [
      {
        id: 'plan',
        type: 'agent',
        role: 'planner',
        prompt: 'Plan the change.',
        harness: 'claude-code',
        models: { 'claude-code': 'claude-model' },
        recoveryPolicy: 'resume_supported',
      },
      {
        id: 'implement',
        type: 'agent',
        role: 'implementer',
        prompt: 'Implement the plan.',
        models: { opencode: 'provider/opencode-model' },
        recoveryPolicy: 'resume_supported',
      },
      { id: 'complete', type: 'complete' },
    ],
    transitions: [
      {
        id: 'plan.success.implement',
        from: { nodeId: 'plan', outcome: 'success' },
        toNodeId: 'implement',
      },
      {
        id: 'implement.success.complete',
        from: { nodeId: 'implement', outcome: 'success' },
        toNodeId: 'complete',
      },
    ],
    counterLimits: {},
  }).unwrap();
}

function location(prefix: string): {
  readonly directory: string;
  readonly database: string;
  readonly artifacts: string;
} {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  return {
    directory,
    database: join(directory, 'runs.sqlite'),
    artifacts: join(directory, 'artifacts'),
  };
}

function storeAt(path: string): SqliteEventStore {
  const store = new SqliteEventStore(path);
  const initialized = store.initialize();
  if (initialized.isErr()) {
    throw new Error(JSON.stringify(initialized.error));
  }
  return store;
}

async function runAdapter(
  harness: AgentHarness,
  runId: string,
): Promise<ReturnType<SqliteEventStore['loadRun']>> {
  const paths = location(`kouro-m4-${harness.id}-`);
  const store = storeAt(paths.database);
  try {
    const executor = new AgentExecutor(
      new HarnessRegistry([harness]),
      new LocalArtifactWriter(paths.artifacts),
    );
    const coordinator = new RunCoordinator(
      store,
      new UnusedCommandRunner(),
      executor,
      paths.directory,
    );
    coordinator
      .createRun({
        runId,
        artifact: artifact(),
        startingCommit: 'abc123',
        configuration: { agentHarnesses: [harness.id] },
        idempotencyKey: 'create',
      })
      .unwrap();
    await coordinator.advance(runId);
    await coordinator.advance(runId);
    await coordinator.advance(runId);
    await coordinator.advance(runId);
    return store.loadRun(runId);
  } finally {
    store.dispose();
    rmSync(paths.directory, { recursive: true, force: true });
  }
}

describe('M4 harness-independent agent execution', () => {
  test('the Bun process runner observes stdout while preserving the full transcript', async () => {
    const chunks: string[] = [];
    const runner = new BunProcessRunner();
    const result = await runner.run(
      process.execPath,
      [
        '-e',
        "process.stdout.write('first\\n'); setTimeout(() => process.stdout.write('second\\n'), 25)",
      ],
      process.cwd(),
      async (chunk) => {
        chunks.push(chunk);
      },
    );

    expect(result.unwrap().stdout).toBe('first\nsecond\n');
    expect(chunks.join('')).toBe('first\nsecond\n');
  });

  test('reuses agent context across graph invocations unless clearContext is set', async () => {
    for (const clearContext of [false, true]) {
      const paths = location(`kouro-agent-context-${clearContext}-`);
      let store = storeAt(paths.database);
      try {
        const harness = new ScriptedFakeHarness('context-fake', [
          { output: { summary: 'Initial implementation' }, transcript: '{}', resumeToken: 'ctx-1' },
          { output: { summary: 'Repair' }, transcript: '{}', resumeToken: 'ctx-1' },
        ]);
        const executor = new AgentExecutor(
          new HarnessRegistry([harness]),
          new LocalArtifactWriter(paths.artifacts),
        );
        let coordinator = new RunCoordinator(
          store,
          new UnusedCommandRunner(),
          executor,
          paths.directory,
        );
        coordinator
          .createRun({
            runId: `context-${clearContext}`,
            artifact: loopingAgentArtifact(clearContext),
            startingCommit: 'abc123',
            configuration: { agentHarnesses: [harness.id] },
            idempotencyKey: 'create',
          })
          .unwrap();

        await coordinator.advance(`context-${clearContext}`);
        await coordinator.advance(`context-${clearContext}`);
        await coordinator.advance(`context-${clearContext}`);
        store.dispose();
        store = storeAt(paths.database);
        coordinator = new RunCoordinator(
          store,
          new UnusedCommandRunner(),
          executor,
          paths.directory,
        );

        for (let step = 0; step < 8; step += 1) {
          const aggregate = store.loadRun(`context-${clearContext}`).unwrap();
          if (aggregate.state.status !== 'running') break;
          (await coordinator.advance(`context-${clearContext}`)).unwrap();
        }

        expect(harness.calls.map(({ operation }) => operation)).toEqual(
          clearContext ? ['execute', 'execute'] : ['execute', 'resume'],
        );
      } finally {
        store.dispose();
        rmSync(paths.directory, { recursive: true, force: true });
      }
    }
  });

  test('structured validation accepts every finite JSON primitive allowed by the schema', () => {
    expect(validateStructuredOutput(false, { type: 'boolean' })).toEqual({ output: false });
    expect(validateStructuredOutput(0, { type: 'number' })).toEqual({ output: 0 });
    expect(validateStructuredOutput('', { type: 'string' })).toEqual({ output: '' });
    expect(validateStructuredOutput(null, { type: 'null' })).toEqual({ output: null });
  });

  test('artifact publication is idempotent and refuses conflicting content', async () => {
    const paths = location('kouro-m4-artifact-');
    try {
      const writer = new LocalArtifactWriter(paths.artifacts);
      const request = {
        runId: 'artifact-run',
        invocationSequence: 1,
        attemptNumber: 1,
        kind: 'agent_output' as const,
        mediaType: 'application/json',
        content: '{"result":"same"}',
      };
      const first = await writer.write(request);
      const repeated = await writer.write(request);
      const conflict = await writer.write({ ...request, content: '{"result":"different"}' });
      expect(repeated.unwrap()).toEqual(first.unwrap());
      expect(conflict.isErr()).toBe(true);
    } finally {
      rmSync(paths.directory, { recursive: true, force: true });
    }
  });

  test('SQLite initialization adds M4 attempt projection columns to an M2 database', () => {
    const paths = location('kouro-m4-migration-');
    const legacy = new Database(paths.database, { create: true });
    legacy.exec(`
      CREATE TABLE attempt_projections (
        run_id TEXT NOT NULL,
        invocation_sequence INTEGER NOT NULL,
        attempt_number INTEGER NOT NULL,
        state TEXT NOT NULL,
        resume_token TEXT,
        PRIMARY KEY (run_id, invocation_sequence, attempt_number)
      );
    `);
    legacy.close();

    const store = storeAt(paths.database);
    try {
      const inspected = new Database(paths.database);
      const columns = inspected
        .query<{ name: string }, []>('SELECT name FROM pragma_table_info("attempt_projections")')
        .all()
        .map(({ name }) => name);
      inspected.close();
      expect(columns).toContain('harness_id');
      expect(columns).toContain('model');
      expect(columns).toContain('failure_json');
    } finally {
      store.dispose();
      rmSync(paths.directory, { recursive: true, force: true });
    }
  });

  test('the same compiled ADW completes through all supported harness adapters', async () => {
    const output = { summary: 'Plan', steps: ['Inspect', 'Implement'] };
    const claudeRunner = new ScriptedProcessRunner([
      {
        exitCode: 0,
        stdout: JSON.stringify({
          is_error: false,
          structured_output: output,
          session_id: 'claude-session',
        }),
        stderr: '',
      },
    ]);
    const codexRunner = new ScriptedProcessRunner([
      {
        exitCode: 0,
        stdout: [
          JSON.stringify({ type: 'thread.started', thread_id: 'codex-session' }),
          JSON.stringify({
            type: 'item.completed',
            item: { type: 'agent_message', text: JSON.stringify(output) },
          }),
        ].join('\n'),
        stderr: '',
      },
    ]);
    const openCodeRunner = new ScriptedProcessRunner([
      {
        exitCode: 0,
        stdout: [
          JSON.stringify({
            type: 'step_start',
            sessionID: 'opencode-session',
            part: { type: 'step-start' },
          }),
          JSON.stringify({
            type: 'text',
            sessionID: 'opencode-session',
            part: { type: 'text', text: JSON.stringify(output) },
          }),
        ].join('\n'),
        stderr: '',
      },
    ]);
    const piRunner = new ScriptedProcessRunner([
      {
        exitCode: 0,
        stdout: [
          JSON.stringify({ type: 'session', version: 3, id: 'pi-session' }),
          JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: JSON.stringify(output) }],
              stopReason: 'stop',
            },
          }),
        ].join('\n'),
        stderr: '',
      },
    ]);

    const claude = await runAdapter(new ClaudeCodeHarness(claudeRunner), 'claude-run');
    const codex = await runAdapter(new CodexHarness(codexRunner), 'codex-run');
    const openCode = await runAdapter(new OpenCodeHarness(openCodeRunner), 'opencode-run');
    const pi = await runAdapter(new PiHarness(piRunner), 'pi-run');

    for (const result of [claude, codex, openCode, pi]) {
      expect(result.unwrap().state.status).toBe('succeeded');
      expect(result.unwrap().state.invocations[0]?.output).toEqual(output);
      expect(result.unwrap().state.invocations[0]?.attempts[0]?.artifacts).toHaveLength(2);
    }
    expect(claudeRunner.calls[0]?.args).toContain('--json-schema');
    expect(claudeRunner.calls[0]?.args).toContain('claude-model');
    expect(codexRunner.calls[0]?.args).toContain('--output-schema');
    expect(codexRunner.calls[0]?.args).toContain('codex-model');
    expect(openCodeRunner.calls[0]?.args).toContain('plan');
    expect(openCodeRunner.calls[0]?.args).toContain('provider/opencode-model');
    expect(openCodeRunner.calls[0]?.args.at(-1)).toContain('Return only JSON matching this schema');
    expect(piRunner.calls[0]?.args).toContain('read,grep,find,ls');
    expect(piRunner.calls[0]?.args).toContain('provider/pi-model');
    expect(piRunner.calls[0]?.args.at(-1)).toContain('Return only JSON matching this schema');
  });

  test('OpenCode and Pi resume the exact recorded session', async () => {
    const output = { summary: 'Resumed', steps: ['Finish'] };
    const openCodeRunner = new ScriptedProcessRunner([
      {
        exitCode: 0,
        stdout: JSON.stringify({
          type: 'text',
          sessionID: 'opencode-session',
          part: { type: 'text', text: JSON.stringify(output) },
        }),
        stderr: '',
      },
    ]);
    const piRunner = new ScriptedProcessRunner([
      {
        exitCode: 0,
        stdout: [
          JSON.stringify({ type: 'session', version: 3, id: 'pi-session' }),
          JSON.stringify({
            type: 'message_end',
            message: {
              role: 'assistant',
              content: [{ type: 'text', text: JSON.stringify(output) }],
              stopReason: 'stop',
            },
          }),
        ].join('\n'),
        stderr: '',
      },
    ]);
    const request = {
      runId: 'resume-adapters',
      invocationSequence: 1,
      attemptNumber: 1,
      workingDirectory: '/tmp',
      role: 'implementer',
      prompt: 'Continue.',
      capabilities: ['repository.read', 'repository.write', 'terminal.execute'],
      model: 'provider/resume-model',
    };

    expect(
      (await new OpenCodeHarness(openCodeRunner).resume(request, 'opencode-session')).unwrap()
        .output,
    ).toEqual(output);
    expect((await new PiHarness(piRunner).resume(request, 'pi-session')).unwrap().output).toEqual(
      output,
    );
    expect(openCodeRunner.calls[0]?.args).toEqual([
      'run',
      '--format',
      'json',
      '--pure',
      '--session',
      'opencode-session',
      '--agent',
      'build',
      '--model',
      'provider/resume-model',
      expect.any(String),
    ]);
    expect(piRunner.calls[0]?.args).toEqual([
      '--mode',
      'json',
      '--session',
      'pi-session',
      '--approve',
      '--no-extensions',
      '--no-skills',
      '--no-prompt-templates',
      '--no-themes',
      '--tools',
      'read,grep,find,ls,edit,write,bash',
      '--model',
      'provider/resume-model',
      expect.any(String),
    ]);
  });

  test('Claude Code and Codex preserve explicit models when resuming', async () => {
    const output = { summary: 'Resumed', steps: ['Finish'] };
    const claudeRunner = new ScriptedProcessRunner([
      {
        exitCode: 0,
        stdout: JSON.stringify({
          is_error: false,
          structured_output: output,
          session_id: 'claude-session',
        }),
        stderr: '',
      },
    ]);
    const codexRunner = new ScriptedProcessRunner([
      {
        exitCode: 0,
        stdout: [
          JSON.stringify({ type: 'thread.started', thread_id: 'codex-session' }),
          JSON.stringify({
            type: 'item.completed',
            item: { type: 'agent_message', text: JSON.stringify(output) },
          }),
        ].join('\n'),
        stderr: '',
      },
    ]);
    const request = {
      runId: 'resume-model-adapters',
      invocationSequence: 1,
      attemptNumber: 1,
      workingDirectory: '/tmp',
      role: 'implementer',
      prompt: 'Continue.',
      capabilities: ['repository.read'],
    };

    expect(
      (
        await new ClaudeCodeHarness(claudeRunner).resume(
          { ...request, model: 'claude-resume-model' },
          'claude-session',
        )
      ).unwrap().output,
    ).toEqual(output);
    expect(
      (
        await new CodexHarness(codexRunner).resume(
          { ...request, model: 'codex-resume-model' },
          'codex-session',
        )
      ).unwrap().output,
    ).toEqual(output);
    expect(claudeRunner.calls[0]?.args).toContain('claude-resume-model');
    expect(codexRunner.calls[0]?.args).toContain('codex-resume-model');
  });

  test('workflow pins override run routing and unpinned agents use node routes', async () => {
    const paths = location('kouro-agent-routing-');
    const store = storeAt(paths.database);
    try {
      const planner = new ScriptedFakeHarness('claude-code', [
        { output: { plan: 'Inspect first' }, transcript: 'planned' },
      ]);
      const implementer = new ScriptedFakeHarness('opencode', [
        { output: { change: 'Implemented' }, transcript: 'implemented' },
      ]);
      const coordinator = new RunCoordinator(
        store,
        new UnusedCommandRunner(),
        new AgentExecutor(
          new HarnessRegistry([planner, implementer]),
          new LocalArtifactWriter(paths.artifacts),
        ),
        paths.directory,
      );
      coordinator
        .createRun({
          runId: 'routed-run',
          artifact: routedAgentArtifact(),
          startingCommit: 'abc123',
          configuration: {
            agentHarnessesByNode: {
              plan: ['opencode'],
              implement: ['opencode'],
            },
          },
          idempotencyKey: 'create',
        })
        .unwrap();

      for (let step = 0; step < 8; step += 1) {
        const aggregate = store.loadRun('routed-run').unwrap();
        if (aggregate.state.status !== 'running') break;
        (await coordinator.advance('routed-run')).unwrap();
      }

      const completed = store.loadRun('routed-run').unwrap();
      expect(completed.state.status).toBe('succeeded');
      expect(
        completed.state.invocations
          .filter(({ nodeId }) => nodeId === 'plan' || nodeId === 'implement')
          .map(({ nodeId, attempts }) => ({
            nodeId,
            harnessId: attempts[0]?.harnessId,
            model: attempts[0]?.model,
          })),
      ).toEqual([
        { nodeId: 'plan', harnessId: 'claude-code', model: 'claude-model' },
        {
          nodeId: 'implement',
          harnessId: 'opencode',
          model: 'provider/opencode-model',
        },
      ]);
      expect(planner.calls[0]?.request.model).toBe('claude-model');
      expect(implementer.calls[0]?.request.model).toBe('provider/opencode-model');
      expect(planner.calls).toHaveLength(1);
      expect(implementer.calls).toHaveLength(1);
    } finally {
      store.dispose();
      rmSync(paths.directory, { recursive: true, force: true });
    }
  });

  test('replay rejects a model that differs from the compiled harness selection', () => {
    const paths = location('kouro-agent-model-replay-');
    const store = storeAt(paths.database);
    try {
      const coordinator = new RunCoordinator(store, new UnusedCommandRunner());
      let current = coordinator
        .createRun({
          runId: 'model-replay-run',
          artifact: artifact({ fake: 'expected-model' }),
          startingCommit: 'abc123',
          configuration: { agentHarnesses: ['fake'] },
          idempotencyKey: 'create',
        })
        .unwrap();
      current = store
        .appendEvent({
          runId: 'model-replay-run',
          expectedSequence: current.nextEventSequence,
          idempotencyKey: 'activate',
          event: {
            type: 'invocation.activated',
            invocationSequence: 1,
            nodeId: 'plan',
          },
        })
        .unwrap();
      const mismatched = store.appendEvent({
        runId: 'model-replay-run',
        expectedSequence: current.nextEventSequence,
        idempotencyKey: 'wrong-model',
        event: {
          type: 'attempt.started',
          invocationSequence: 1,
          attemptNumber: 1,
          harnessId: 'fake',
          model: 'different-model',
        },
      });

      expect(mismatched.isErr()).toBe(true);
    } finally {
      store.dispose();
      rmSync(paths.directory, { recursive: true, force: true });
    }
  });

  test('invalid structured output is persisted as a typed node failure', async () => {
    const paths = location('kouro-m4-invalid-');
    const store = storeAt(paths.database);
    try {
      const harness = new ScriptedFakeHarness('fake', [
        { output: { summary: 'Missing steps' }, transcript: '{}' },
      ]);
      const coordinator = new RunCoordinator(
        store,
        new UnusedCommandRunner(),
        new AgentExecutor(new HarnessRegistry([harness]), new LocalArtifactWriter(paths.artifacts)),
        paths.directory,
      );
      coordinator
        .createRun({
          runId: 'invalid-run',
          artifact: artifact(),
          startingCommit: 'abc123',
          configuration: { agentHarnesses: ['fake'] },
          idempotencyKey: 'create',
        })
        .unwrap();
      await coordinator.advance('invalid-run');
      const failed = await coordinator.advance('invalid-run');
      expect(failed.isErr()).toBe(true);
      if (failed.isErr()) expect(failed.error.kind).toBe(ExecutorErrorKind.Agent);

      const persisted = store.loadRun('invalid-run').unwrap();
      expect(persisted.state.invocations[0]?.state).toBe('failed');
      expect(persisted.state.invocations[0]?.attempts[0]?.failure?.kind).toBe(
        'invalid_structured_output',
      );
      const completed = (await coordinator.advance('invalid-run')).unwrap();
      expect(completed.state.status).toBe('failed');
    } finally {
      store.dispose();
      rmSync(paths.directory, { recursive: true, force: true });
    }
  });

  test('fallback creates another attempt in the same invocation', async () => {
    const paths = location('kouro-m4-fallback-');
    const store = storeAt(paths.database);
    try {
      const primary = new ScriptedFakeHarness('primary', [
        err({ kind: HarnessErrorKind.ProcessFailure, message: 'provider unavailable' }),
      ]);
      const fallback = new ScriptedFakeHarness('fallback', [
        {
          output: { summary: 'Recovered', steps: ['Continue'] },
          transcript: '{}',
        },
      ]);
      const coordinator = new RunCoordinator(
        store,
        new UnusedCommandRunner(),
        new AgentExecutor(
          new HarnessRegistry([primary, fallback]),
          new LocalArtifactWriter(paths.artifacts),
        ),
        paths.directory,
      );
      coordinator
        .createRun({
          runId: 'fallback-run',
          artifact: artifact({
            primary: 'primary-model',
            fallback: 'fallback-model',
          }),
          startingCommit: 'abc123',
          configuration: {
            agentHarnesses: ['primary'],
            agentHarnessesByNode: { plan: ['primary', 'fallback'] },
          },
          idempotencyKey: 'create',
        })
        .unwrap();
      await coordinator.advance('fallback-run');
      expect((await coordinator.advance('fallback-run')).isErr()).toBe(true);
      await coordinator.advance('fallback-run');

      const invocation = store.loadRun('fallback-run').unwrap().state.invocations[0];
      expect(invocation?.sequence).toBe(1);
      expect(
        invocation?.attempts.map(({ number, harnessId, model, state }) => ({
          number,
          harnessId,
          model,
          state,
        })),
      ).toEqual([
        { number: 1, harnessId: 'primary', model: 'primary-model', state: 'failed' },
        {
          number: 2,
          harnessId: 'fallback',
          model: 'fallback-model',
          state: 'succeeded',
        },
      ]);
      expect(primary.calls[0]?.request.model).toBe('primary-model');
      expect(fallback.calls[0]?.request.model).toBe('fallback-model');
    } finally {
      store.dispose();
      rmSync(paths.directory, { recursive: true, force: true });
    }
  });

  test('resume continues the interrupted harness session without a new attempt', async () => {
    const paths = location('kouro-m4-resume-');
    const store = storeAt(paths.database);
    try {
      const harness = new ScriptedFakeHarness('fake', [
        {
          output: { summary: 'Resumed', steps: ['Finish'] },
          transcript: '{}',
          resumeToken: 'session-1',
        },
      ]);
      const coordinator = new RunCoordinator(
        store,
        new UnusedCommandRunner(),
        new AgentExecutor(new HarnessRegistry([harness]), new LocalArtifactWriter(paths.artifacts)),
        paths.directory,
      );
      const created = coordinator
        .createRun({
          runId: 'resume-run',
          artifact: artifact(),
          startingCommit: 'abc123',
          configuration: { agentHarnesses: ['fake'] },
          idempotencyKey: 'create',
        })
        .unwrap();
      let current = store
        .appendEvent({
          runId: 'resume-run',
          expectedSequence: created.nextEventSequence,
          idempotencyKey: 'activate',
          event: { type: 'invocation.activated', invocationSequence: 1, nodeId: 'plan' },
        })
        .unwrap();
      current = store
        .appendEvent({
          runId: 'resume-run',
          expectedSequence: current.nextEventSequence,
          idempotencyKey: 'started',
          event: {
            type: 'attempt.started',
            invocationSequence: 1,
            attemptNumber: 1,
            harnessId: 'fake',
          },
        })
        .unwrap();
      current = store
        .appendEvent({
          runId: 'resume-run',
          expectedSequence: current.nextEventSequence,
          idempotencyKey: 'token',
          event: {
            type: 'attempt.resume_token_recorded',
            invocationSequence: 1,
            attemptNumber: 1,
            resumeToken: 'session-1',
          },
        })
        .unwrap();
      store
        .appendEvent({
          runId: 'resume-run',
          expectedSequence: current.nextEventSequence,
          idempotencyKey: 'interrupted',
          event: { type: 'attempt.interrupted', invocationSequence: 1, attemptNumber: 1 },
        })
        .unwrap();

      await coordinator.advance('resume-run');
      const resumed = store.loadRun('resume-run').unwrap().state.invocations[0];
      expect(resumed?.state).toBe('succeeded');
      expect(resumed?.attempts).toHaveLength(1);
      expect(harness.calls).toEqual([
        expect.objectContaining({ operation: 'resume', token: 'session-1' }),
      ]);
    } finally {
      store.dispose();
      rmSync(paths.directory, { recursive: true, force: true });
    }
  });
});
