import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { compileWorkflow } from '@kouro/adw';
import { createKouroApp } from '@kouro/api';
import type { WorkflowSourceBundle } from '@kouro/domain';
import {
  AgentExecutor,
  RunCoordinator,
  type CommandExecution,
  type CommandRunner,
  type CommandRunnerError,
} from '@kouro/executors';
import {
  CodexHarness,
  HarnessRegistry,
  LocalArtifactWriter,
  type CodexAppServerMessage,
  type CodexAppServerTransport,
  type CodexAppServerTransportFactory,
} from '@kouro/harnesses';
import { SqliteEventStore } from '@kouro/persistence-sqlite';
import { ok, type Result } from '@usersatoshi/results';

class UnusedCommandRunner implements CommandRunner {
  execute(): Promise<Result<CommandExecution, CommandRunnerError>> {
    throw new Error('Command execution is not expected');
  }
}

class SteeringAppServerFactory implements CodexAppServerTransportFactory {
  readonly requests: string[] = [];

  open(): Promise<Result<CodexAppServerTransport, never>> {
    const listeners = new Set<(message: CodexAppServerMessage) => void>();
    const emit = (message: CodexAppServerMessage): void => {
      for (const listener of listeners) listener(message);
    };
    return Promise.resolve(
      ok({
        request: (method: string) => {
          this.requests.push(method);
          if (method === 'thread/start') {
            return Promise.resolve(ok({ thread: { id: 'durable-thread' } }));
          }
          if (method === 'turn/start') {
            return Promise.resolve(ok({ turn: { id: 'active-turn' } }));
          }
          if (method === 'turn/steer') {
            queueMicrotask(() =>
              emit({
                method: 'turn/completed',
                params: {
                  turn: {
                    id: 'active-turn',
                    status: 'completed',
                    items: [{ type: 'agentMessage', text: '{"summary":"steered"}' }],
                  },
                },
              }),
            );
            return Promise.resolve(ok({ turnId: 'active-turn' }));
          }
          return Promise.resolve(ok({}));
        },
        notify: (method: string) => {
          this.requests.push(method);
        },
        respond: () => undefined,
        subscribe: (listener: (message: CodexAppServerMessage) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        transcript: () => '',
        dispose: () => Promise.resolve(),
      }),
    );
  }
}

class InterruptingAppServerFactory implements CodexAppServerTransportFactory {
  readonly requests: string[] = [];

  open(): Promise<Result<CodexAppServerTransport, never>> {
    const listeners = new Set<(message: CodexAppServerMessage) => void>();
    const emit = (message: CodexAppServerMessage): void => {
      for (const listener of listeners) listener(message);
    };
    return Promise.resolve(
      ok({
        request: (method: string) => {
          this.requests.push(method);
          if (method === 'thread/start') {
            return Promise.resolve(ok({ thread: { id: 'interrupt-thread' } }));
          }
          if (method === 'turn/start') {
            return Promise.resolve(ok({ turn: { id: 'interrupt-turn' } }));
          }
          if (method === 'turn/interrupt') {
            queueMicrotask(() =>
              emit({
                method: 'turn/completed',
                params: {
                  turn: { id: 'interrupt-turn', status: 'interrupted', items: [] },
                },
              }),
            );
          }
          return Promise.resolve(ok({}));
        },
        notify: (method: string) => {
          this.requests.push(method);
        },
        respond: () => undefined,
        subscribe: (listener: (message: CodexAppServerMessage) => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        transcript: () => '',
        dispose: () => Promise.resolve(),
      }),
    );
  }
}

function workflow(): WorkflowSourceBundle {
  return {
    manifest: { id: 'steering-api', version: '1.0.0' },
    semanticVersions: { compiler: '0.1.0', ir: '1', expressions: '1' },
    entryNodeId: 'agent',
    nodes: [
      {
        id: 'agent',
        type: 'agent',
        role: 'implementer',
        prompt: 'Implement.',
        capabilities: ['repository.read'],
        recoveryPolicy: 'resume_supported',
      },
    ],
    transitions: [],
    counterLimits: {},
    permissions: ['repository.read'],
  };
}

describe('Codex live steering API', () => {
  test('persists steering before returning success to another process', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kouro-steering-api-'));
    const store = new SqliteEventStore(join(directory, 'runs.sqlite'));
    try {
      expect(store.initialize().isOk()).toBe(true);
      const artifact = compileWorkflow(workflow()).unwrap();
      const coordinator = new RunCoordinator(store, new UnusedCommandRunner());
      let aggregate = coordinator
        .createRun({
          runId: 'steering-run',
          artifact,
          startingCommit: 'abc123',
          configuration: { agentHarnesses: ['codex'] },
          idempotencyKey: 'create',
        })
        .unwrap();
      aggregate = store
        .appendEvent({
          runId: aggregate.runId,
          expectedSequence: aggregate.nextEventSequence,
          idempotencyKey: 'activate',
          event: {
            type: 'invocation.activated',
            invocationSequence: 1,
            nodeId: 'agent',
          },
        })
        .unwrap();
      store
        .appendEvent({
          runId: aggregate.runId,
          expectedSequence: aggregate.nextEventSequence,
          idempotencyKey: 'start',
          event: {
            type: 'attempt.started',
            invocationSequence: 1,
            attemptNumber: 1,
            harnessId: 'codex',
          },
        })
        .unwrap();

      const app = createKouroApp({ runs: store, coordinator });
      const response = await app.handle(
        new Request('http://kouro.test/runs/steering-run/invocations/1/steer', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            actor: 'operator',
            message: 'Keep the existing public API.',
            idempotencyKey: 'steer-1',
          }),
        }),
      );

      expect(response.status).toBe(200);
      const reloaded = store.loadRun('steering-run').unwrap();
      expect(reloaded.events.at(-1)).toEqual({
        sequence: 4,
        type: 'agent.steering_requested',
        invocationSequence: 1,
        attemptNumber: 1,
        actor: 'operator',
        message: 'Keep the existing public API.',
      });
      expect(reloaded.state.invocations[0]?.attempts[0]?.steering?.[0]?.state).toBe('pending');
    } finally {
      store.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('delivers persisted steering to the worker-owned App Server turn', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kouro-steering-worker-'));
    const store = new SqliteEventStore(join(directory, 'runs.sqlite'));
    try {
      expect(store.initialize().isOk()).toBe(true);
      const artifact = compileWorkflow(workflow()).unwrap();
      const factory = new SteeringAppServerFactory();
      const coordinator = new RunCoordinator(
        store,
        new UnusedCommandRunner(),
        new AgentExecutor(
          new HarnessRegistry([new CodexHarness(factory)]),
          new LocalArtifactWriter(join(directory, 'artifacts')),
        ),
        directory,
      );
      coordinator
        .createRun({
          runId: 'live-steering-run',
          artifact,
          startingCommit: 'abc123',
          configuration: { agentHarnesses: ['codex'] },
          idempotencyKey: 'create',
        })
        .unwrap();
      await coordinator.advance('live-steering-run');
      const execution = coordinator.advance('live-steering-run');

      for (;;) {
        const active = store.loadRun('live-steering-run').unwrap();
        if (active.state.invocations[0]?.attempts[0]?.resumeToken === 'durable-thread') break;
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      coordinator
        .steerInvocation('live-steering-run', 1, 'operator', 'Keep compatibility.', 'steer-live')
        .unwrap();

      const completed = await execution;
      expect(completed.isOk()).toBe(true);
      const reloaded = store.loadRun('live-steering-run').unwrap();
      expect(reloaded.state.invocations[0]?.state).toBe('succeeded');
      expect(reloaded.state.invocations[0]?.output).toEqual({ summary: 'steered' });
      expect(reloaded.state.invocations[0]?.attempts[0]?.steering?.[0]?.state).toBe('applied');
      expect(factory.requests).toContain('turn/steer');
      expect(reloaded.events.map(({ type }) => type)).toEqual(
        expect.arrayContaining([
          'attempt.resume_token_recorded',
          'agent.steering_requested',
          'agent.steering_applied',
          'invocation.completed',
        ]),
      );
    } finally {
      store.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('interrupts the App Server turn without recording a false attempt failure', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kouro-interrupt-worker-'));
    const store = new SqliteEventStore(join(directory, 'runs.sqlite'));
    try {
      expect(store.initialize().isOk()).toBe(true);
      const factory = new InterruptingAppServerFactory();
      const coordinator = new RunCoordinator(
        store,
        new UnusedCommandRunner(),
        new AgentExecutor(
          new HarnessRegistry([new CodexHarness(factory)]),
          new LocalArtifactWriter(join(directory, 'artifacts')),
        ),
        directory,
      );
      coordinator
        .createRun({
          runId: 'live-interrupt-run',
          artifact: compileWorkflow(workflow()).unwrap(),
          startingCommit: 'abc123',
          configuration: { agentHarnesses: ['codex'] },
          idempotencyKey: 'create',
        })
        .unwrap();
      await coordinator.advance('live-interrupt-run');
      const execution = coordinator.advance('live-interrupt-run');

      for (;;) {
        const active = store.loadRun('live-interrupt-run').unwrap();
        if (active.state.invocations[0]?.attempts[0]?.resumeToken === 'interrupt-thread') break;
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
      }
      coordinator
        .interruptInvocation(
          'live-interrupt-run',
          1,
          'operator',
          'Pause for review.',
          'interrupt-live',
        )
        .unwrap();

      const interrupted = await execution;
      expect(interrupted.isOk()).toBe(true);
      const reloaded = store.loadRun('live-interrupt-run').unwrap();
      expect(reloaded.state.invocations[0]?.state).toBe('interrupted');
      expect(factory.requests).toContain('turn/interrupt');
      expect(reloaded.events.some(({ type }) => type === 'attempt.failed')).toBe(false);
      expect(reloaded.events.some(({ type }) => type === 'invocation.completed')).toBe(false);
    } finally {
      store.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
