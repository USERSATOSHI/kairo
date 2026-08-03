import { describe, expect, test } from 'bun:test';

import {
  HarnessErrorKind,
  type AgentControlChannel,
  type HarnessExecutionRequest,
} from '@kouro/executors';
import {
  CodexHarness,
  type CodexAppServerMessage,
  type CodexAppServerTransport,
  type CodexAppServerTransportFactory,
} from '@kouro/harnesses';
import { ok, type Result } from '@usersatoshi/results';

type CompletionMode = 'start' | 'steer' | 'interrupt' | 'tool';

class FakeAppServerTransport implements CodexAppServerTransport {
  readonly requests: { readonly method: string; readonly params: unknown }[] = [];
  readonly responses: { readonly id: number | string; readonly result: unknown }[] = [];
  private readonly listeners = new Set<(message: CodexAppServerMessage) => void>();
  private readonly transcriptLines: string[] = [];

  constructor(
    private readonly output: unknown,
    private readonly completionMode: CompletionMode,
  ) {}

  request(method: string, params: unknown): Promise<Result<unknown, never>> {
    this.requests.push({ method, params });
    if (method === 'thread/start' || method === 'thread/resume') {
      return Promise.resolve(ok({ thread: { id: 'thread-1' } }));
    }
    if (method === 'turn/start') {
      if (this.completionMode === 'start') queueMicrotask(() => this.complete('completed'));
      if (this.completionMode === 'tool') {
        queueMicrotask(() =>
          this.emit({
            id: 77,
            method: 'item/tool/call',
            params: {
              threadId: 'thread-1',
              turnId: 'turn-1',
              callId: 'call-1',
              namespace: null,
              tool: 'subagent',
              arguments: { subagent: 'scout', task: 'Inspect tests' },
            },
          }),
        );
      }
      return Promise.resolve(ok({ turn: { id: 'turn-1' } }));
    }
    if (method === 'turn/steer') {
      if (this.completionMode === 'steer') queueMicrotask(() => this.complete('completed'));
      return Promise.resolve(ok({ turnId: 'turn-1' }));
    }
    if (method === 'turn/interrupt') {
      if (this.completionMode === 'interrupt') queueMicrotask(() => this.complete('interrupted'));
      return Promise.resolve(ok({}));
    }
    return Promise.resolve(ok({}));
  }

  notify(method: string, params: unknown): void {
    this.requests.push({ method, params });
  }

  respond(id: number | string, result: unknown): void {
    this.responses.push({ id, result });
    if (this.completionMode === 'tool' && id === 77) {
      queueMicrotask(() => this.complete('completed'));
    }
  }

  subscribe(listener: (message: CodexAppServerMessage) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  transcript(): string {
    return this.transcriptLines.join('\n');
  }

  dispose(): Promise<void> {
    return Promise.resolve();
  }

  emit(message: CodexAppServerMessage): void {
    this.transcriptLines.push(JSON.stringify(message));
    for (const listener of this.listeners) listener(message);
  }

  private complete(status: 'completed' | 'interrupted'): void {
    this.emit({
      method: 'turn/completed',
      params: {
        turn: {
          id: 'turn-1',
          status,
          items:
            status === 'completed'
              ? [{ type: 'agentMessage', text: JSON.stringify(this.output) }]
              : [],
        },
      },
    });
  }
}

class FakeAppServerFactory implements CodexAppServerTransportFactory {
  readonly transport: FakeAppServerTransport;

  constructor(output: unknown, completionMode: CompletionMode = 'start') {
    this.transport = new FakeAppServerTransport(output, completionMode);
  }

  open(): Promise<Result<CodexAppServerTransport, never>> {
    return Promise.resolve(ok(this.transport));
  }
}

function request(additional: Partial<HarnessExecutionRequest> = {}): HarnessExecutionRequest {
  return {
    runId: 'run-1',
    invocationSequence: 1,
    attemptNumber: 1,
    workingDirectory: '/tmp/worktree',
    role: 'implementer',
    prompt: 'Implement the change.',
    capabilities: ['repository.read', 'repository.write'],
    ...additional,
  };
}

describe('ADR-0028: Codex App Server harness', () => {
  test('starts a thread and applies a capability-derived turn sandbox', async () => {
    const factory = new FakeAppServerFactory({ summary: 'done' });
    const tokens: string[] = [];
    const result = await new CodexHarness(factory).execute(
      request({
        model: 'gpt-test',
        reasoningEffort: 'high',
        outputSchema: {
          type: 'object',
          properties: { summary: { type: 'string' } },
          required: ['summary'],
        },
        onResumeToken: (token) => {
          tokens.push(token);
          return Promise.resolve();
        },
      }),
    );

    expect(result.isOk()).toBe(true);
    expect(result.unwrap().output).toEqual({ summary: 'done' });
    expect(result.unwrap().resumeToken).toBe('thread-1');
    expect(tokens).toEqual(['thread-1']);
    expect(
      factory.transport.requests.find(({ method }) => method === 'initialize')?.params,
    ).toEqual({
      clientInfo: { name: 'kouro', title: 'Kouro', version: '0.1.0' },
      capabilities: null,
    });
    expect(
      factory.transport.requests.find(({ method }) => method === 'turn/start')?.params,
    ).toMatchObject({
      threadId: 'thread-1',
      model: 'gpt-test',
      effort: 'high',
      approvalPolicy: 'on-request',
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: ['/tmp/worktree'],
        networkAccess: false,
      },
      outputSchema: expect.any(Object),
    });
  });

  test('forwards durable steering to the active turn and acknowledges it', async () => {
    const factory = new FakeAppServerFactory({ summary: 'steered' }, 'steer');
    let applied = false;
    const controls: AgentControlChannel = {
      read: () =>
        Promise.resolve({
          steering: applied ? [] : [{ requestSequence: 8, message: 'Preserve compatibility.' }],
          interruptRequested: false,
        }),
      steeringApplied: (sequence) => {
        expect(sequence).toBe(8);
        applied = true;
        return Promise.resolve();
      },
      steeringRejected: () => Promise.resolve(),
    };

    const result = await new CodexHarness(factory).execute(request({ controls }));

    expect(result.isOk()).toBe(true);
    expect(applied).toBe(true);
    expect(
      factory.transport.requests.find(({ method }) => method === 'turn/steer')?.params,
    ).toEqual({
      threadId: 'thread-1',
      expectedTurnId: 'turn-1',
      input: [{ type: 'text', text: 'Preserve compatibility.' }],
    });
  });

  test('exposes and answers the normalized subagent dynamic tool', async () => {
    const factory = new FakeAppServerFactory({ summary: 'delegated' }, 'tool');
    const calls: unknown[] = [];
    const result = await new CodexHarness(factory).execute(
      request({
        subagents: {
          definitions: [{ id: 'scout', role: 'test-scout' }],
          invoke: (subagent, task) => {
            calls.push({ subagent, task });
            return Promise.resolve({
              callId: 'scout:1',
              success: true,
              output: { files: ['test.ts'] },
            });
          },
        },
      }),
    );

    expect(result.isOk()).toBe(true);
    expect(calls).toEqual([{ subagent: 'scout', task: 'Inspect tests' }]);
    expect(
      factory.transport.requests.find(({ method }) => method === 'thread/start')?.params,
    ).toMatchObject({
      dynamicTools: [
        {
          type: 'function',
          name: 'subagent',
          inputSchema: {
            required: ['subagent', 'task'],
          },
        },
      ],
    });
    expect(factory.transport.responses).toContainEqual({
      id: 77,
      result: {
        contentItems: [
          {
            type: 'inputText',
            text: JSON.stringify({
              callId: 'scout:1',
              success: true,
              output: { files: ['test.ts'] },
            }),
          },
        ],
        success: true,
      },
    });
  });

  test('turns a durable interrupt into an App Server interruption', async () => {
    const factory = new FakeAppServerFactory({}, 'interrupt');
    const controls: AgentControlChannel = {
      read: () => Promise.resolve({ steering: [], interruptRequested: true }),
      steeringApplied: () => Promise.resolve(),
      steeringRejected: () => Promise.resolve(),
    };

    const result = await new CodexHarness(factory).execute(request({ controls }));

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.kind).toBe(HarnessErrorKind.ProcessFailure);
    expect(factory.transport.requests.map(({ method }) => method)).toContain('turn/interrupt');
  });

  test('answers tool approvals from compiled capabilities', async () => {
    const factory = new FakeAppServerFactory({ summary: 'done' }, 'steer');
    const execution = new CodexHarness(factory).execute(
      request({ capabilities: ['repository.read', 'repository.write'] }),
    );
    while (!factory.transport.requests.some(({ method }) => method === 'turn/start')) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    factory.transport.emit({
      id: 41,
      method: 'item/commandExecution/requestApproval',
      params: {},
    });
    factory.transport.emit({
      id: 42,
      method: 'item/fileChange/requestApproval',
      params: {},
    });
    factory.transport.emit({
      method: 'turn/completed',
      params: {
        turn: {
          id: 'turn-1',
          status: 'completed',
          items: [{ type: 'agentMessage', text: JSON.stringify({ summary: 'done' }) }],
        },
      },
    });
    await execution;

    expect(factory.transport.responses).toEqual([
      { id: 41, result: { decision: 'decline' } },
      { id: 42, result: { decision: 'accept' } },
    ]);
  });
});
