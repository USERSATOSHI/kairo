import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'bun:test';

import { compileWorkflow } from '@kouro/adw';
import {
  createKouroApp,
  listApprovals,
  LocalArtifactContentReader,
  type ArtifactContentReader,
} from '@kouro/api';
import type { ArtifactReference, WorkflowSourceBundle } from '@kouro/domain';
import type { CommandExecution, CommandRunner, CommandRunnerError } from '@kouro/executors';
import { AgentExecutor, RunCoordinator } from '@kouro/executors';
import { HarnessRegistry, LocalArtifactWriter, ScriptedFakeHarness } from '@kouro/harnesses';
import { SqliteEventStore } from '@kouro/persistence-sqlite';
import { ok, type Result } from '@usersatoshi/results';

class UnusedCommandRunner implements CommandRunner {
  execute(): Promise<Result<CommandExecution, CommandRunnerError>> {
    throw new Error('The approval-only API fixture must not execute commands');
  }
}

const artifactReference: ArtifactReference = {
  id: 'delivery.diff',
  kind: 'git_diff',
  mediaType: 'text/x-diff',
  checksum: `sha256:${'1'.repeat(64)}`,
  size: 18,
};

function approvalWorkflow(): WorkflowSourceBundle {
  return {
    manifest: { id: 'api-approval', version: '1.0.0' },
    semanticVersions: { compiler: '0.1.0', ir: '1', expressions: '1' },
    entryNodeId: 'approve',
    nodes: [
      {
        id: 'approve',
        type: 'approval',
        title: 'Ship the change',
        skipOutcome: 'rejected',
      },
      { id: 'complete', type: 'complete' },
      { id: 'failed', type: 'complete', result: 'failed' },
    ],
    transitions: [
      {
        id: 'approve.approved.complete',
        from: { nodeId: 'approve', outcome: 'approved' },
        toNodeId: 'complete',
      },
      {
        id: 'approve.rejected.failed',
        from: { nodeId: 'approve', outcome: 'rejected' },
        toNodeId: 'failed',
      },
    ],
    counterLimits: {},
  };
}

function planApprovalWorkflow(): WorkflowSourceBundle {
  return {
    manifest: { id: 'plan-approval', version: '1.0.0' },
    semanticVersions: { compiler: '0.1.0', ir: '1', expressions: '1' },
    entryNodeId: 'plan',
    nodes: [
      {
        id: 'plan',
        type: 'agent',
        role: 'planner',
        prompt: 'Create the implementation plan.',
        recoveryPolicy: 'resume_supported',
      },
      { id: 'approve', type: 'approval', title: 'Approve the plan' },
      { id: 'complete', type: 'complete' },
    ],
    transitions: [
      {
        id: 'plan.success.approve',
        from: { nodeId: 'plan', outcome: 'success' },
        toNodeId: 'approve',
      },
      {
        id: 'approve.approved.complete',
        from: { nodeId: 'approve', outcome: 'approved' },
        toNodeId: 'complete',
      },
    ],
    counterLimits: {},
  };
}

function responseJson(response: Response): Promise<unknown> {
  return response.json();
}

const disposals: (() => void)[] = [];

afterEach(() => {
  while (disposals.length > 0) disposals.pop()?.();
});

describe('M6 observable Elysia and web MVP', () => {
  test('projects the source plan into its approval read model', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kouro-plan-approval-'));
    const store = new SqliteEventStore(join(directory, 'runs.sqlite'));
    const initialized = store.initialize();
    if (initialized.isErr()) throw new Error(JSON.stringify(initialized.error));
    disposals.push(() => {
      store.dispose();
      rmSync(directory, { recursive: true, force: true });
    });
    const harness = new ScriptedFakeHarness('fake', [
      {
        output: {
          summary: 'Add the ticket launcher',
          steps: ['Extend the API contract', 'Render the launch dialog'],
        },
        transcript: '{}',
      },
    ]);
    const coordinator = new RunCoordinator(
      store,
      new UnusedCommandRunner(),
      new AgentExecutor(
        new HarnessRegistry([harness]),
        new LocalArtifactWriter(join(directory, 'artifacts')),
      ),
      directory,
    );
    coordinator
      .createRun({
        runId: 'plan-run',
        artifact: compileWorkflow(planApprovalWorkflow()).unwrap(),
        startingCommit: 'abc123',
        configuration: { agentHarnesses: ['fake'] },
        idempotencyKey: 'create-plan-run',
      })
      .unwrap();
    for (let step = 0; step < 4; step += 1) {
      const advanced = await coordinator.advance('plan-run');
      if (advanced.isErr()) throw new Error(JSON.stringify(advanced.error));
    }

    expect(listApprovals({ runs: store, coordinator }, 'plan-run').unwrap()).toEqual([
      expect.objectContaining({
        nodeId: 'approve',
        proposal: {
          nodeId: 'plan',
          invocationSequence: 1,
          output: {
            summary: 'Add the ticket launcher',
            steps: ['Extend the API contract', 'Render the launch dialog'],
          },
        },
      }),
    ]);
  });

  test('local artifact reads verify durable size and checksum metadata', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kouro-m6-artifact-'));
    disposals.push(() => rmSync(directory, { recursive: true, force: true }));
    const writer = new LocalArtifactWriter(directory);
    const artifact = (
      await writer.write({
        runId: 'artifact-run',
        invocationSequence: 2,
        attemptNumber: 1,
        kind: 'harness_transcript',
        mediaType: 'application/x-ndjson',
        content: '{"event":"complete"}\n',
      })
    ).unwrap();
    const reader = new LocalArtifactContentReader(directory);

    expect((await reader.read('artifact-run', artifact, 2, 1)).unwrap().content).toBe(
      '{"event":"complete"}\n',
    );
    expect(
      (
        await reader.read(
          'artifact-run',
          { ...artifact, checksum: `sha256:${'0'.repeat(64)}` },
          2,
          1,
        )
      ).isErr(),
    ).toBe(true);

    const gitStatus = (
      await writer.write({
        runId: 'artifact-run',
        invocationSequence: 4,
        attemptNumber: 0,
        kind: 'git_status',
        mediaType: 'text/plain',
        content: ' M packages/web/src/App.tsx\n',
      })
    ).unwrap();
    expect((await reader.read('artifact-run', gitStatus)).unwrap().content).toBe(
      ' M packages/web/src/App.tsx\n',
    );
  });

  test('factory exposes durable state and decides an approval without opening a port', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kouro-m6-api-'));
    const store = new SqliteEventStore(join(directory, 'runs.sqlite'));
    const initialized = store.initialize();
    if (initialized.isErr()) throw new Error(JSON.stringify(initialized.error));
    disposals.push(() => {
      store.dispose();
      rmSync(directory, { recursive: true, force: true });
    });

    const compiled = compileWorkflow(approvalWorkflow()).unwrap();
    const coordinator = new RunCoordinator(store, new UnusedCommandRunner());
    coordinator
      .createRun({
        runId: 'observable-run',
        artifact: compiled,
        startingCommit: 'abc123',
        configuration: {},
        idempotencyKey: 'create',
      })
      .unwrap();
    await coordinator.advance('observable-run');
    coordinator.publishRunArtifact('observable-run', artifactReference, 'publish-diff').unwrap();
    await coordinator.advance('observable-run');

    const reader: ArtifactContentReader = {
      read() {
        return Promise.resolve(
          ok({
            mediaType: 'text/x-diff',
            content: '+ observable diff',
          }),
        );
      },
    };
    const app = createKouroApp({
      runs: store,
      coordinator,
      artifacts: reader,
      repositories: {
        list: () =>
          Promise.resolve([
            {
              id: 'kouro',
              path: '/repositories/kouro',
              startingCommit: 'abc123',
            },
          ]),
      },
    });

    const runsResponse = await app.handle(new Request('http://kouro.test/runs'));
    expect(runsResponse.status).toBe(200);
    expect(await responseJson(runsResponse)).toEqual([
      expect.objectContaining({
        id: 'observable-run',
        status: 'waiting_for_approval',
        pendingApprovalCount: 1,
      }),
    ]);

    const runResponse = await app.handle(new Request('http://kouro.test/runs/observable-run'));
    expect(await responseJson(runResponse)).toEqual(
      expect.objectContaining({
        nodes: expect.arrayContaining([
          expect.objectContaining({
            id: 'approve',
            latestState: 'waiting_for_approval',
            skipOutcome: 'rejected',
          }),
        ]),
        edges: expect.arrayContaining([
          expect.objectContaining({ id: 'approve.approved.complete' }),
        ]),
      }),
    );

    const artifactResponse = await app.handle(
      new Request('http://kouro.test/runs/observable-run/artifacts/delivery.diff'),
    );
    expect(await responseJson(artifactResponse)).toEqual(
      expect.objectContaining({ id: 'delivery.diff', content: '+ observable diff' }),
    );

    const approvalsResponse = await app.handle(
      new Request('http://kouro.test/runs/observable-run/approvals'),
    );
    const approvals = await responseJson(approvalsResponse);
    if (!Array.isArray(approvals) || !approvals[0]) throw new Error('Approval view missing');
    const decisionBody = {
      decision: 'grant',
      actor: 'user:test',
      reason: 'The recorded diff is ready',
      idempotencyKey: 'web:approval:1',
      binding: approvals[0].binding,
      expectedEventSequence: approvals[0].expectedEventSequence,
    };
    const approvalResponse = await app.handle(
      new Request('http://kouro.test/runs/observable-run/approvals/1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(decisionBody),
      }),
    );
    expect(approvalResponse.status).toBe(200);
    expect(await responseJson(approvalResponse)).toEqual({
      runId: 'observable-run',
      invocationSequence: 1,
      status: 'running',
    });
    expect(store.loadRun('observable-run').unwrap().events.at(-1)?.type).toBe('approval.granted');
    const staleResponse = await app.handle(
      new Request('http://kouro.test/runs/observable-run/approvals/1', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...decisionBody, idempotencyKey: 'web:approval:stale' }),
      }),
    );
    expect(staleResponse.status).toBe(409);

    expect(
      await responseJson(await app.handle(new Request('http://kouro.test/workflows'))),
    ).toEqual([expect.objectContaining({ id: 'api-approval', nodeCount: 3 })]);
    expect(
      await responseJson(await app.handle(new Request('http://kouro.test/repositories'))),
    ).toEqual([expect.objectContaining({ id: 'kouro' })]);
  });

  test('event reconnect replays only sequences after the client cursor', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kouro-m6-events-'));
    const store = new SqliteEventStore(join(directory, 'runs.sqlite'));
    const initialized = store.initialize();
    if (initialized.isErr()) throw new Error(JSON.stringify(initialized.error));
    disposals.push(() => {
      store.dispose();
      rmSync(directory, { recursive: true, force: true });
    });
    const coordinator = new RunCoordinator(store, new UnusedCommandRunner());
    coordinator
      .createRun({
        runId: 'reconnect-run',
        artifact: compileWorkflow(approvalWorkflow()).unwrap(),
        startingCommit: 'abc123',
        configuration: {},
        idempotencyKey: 'create',
      })
      .unwrap();
    await coordinator.advance('reconnect-run');
    await coordinator.advance('reconnect-run');
    const app = createKouroApp({ runs: store, coordinator });

    const response = await app.handle(
      new Request('http://kouro.test/runs/reconnect-run/events', {
        headers: { 'last-event-id': '1' },
      }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const stream = await response.text();
    expect(stream).not.toContain('id: 1\n');
    expect(stream).toContain('id: 2\n');
    expect(stream).toContain('event: approval.requested');
  });

  test('domain and runtime remain free of Elysia imports', async () => {
    const files = [
      ...(await Array.fromAsync(new Bun.Glob('packages/domain/src/**/*.ts').scan('.'))),
      ...(await Array.fromAsync(new Bun.Glob('packages/runtime/src/**/*.ts').scan('.'))),
    ];
    for (const file of files) {
      expect(await Bun.file(file).text()).not.toContain('elysia');
    }
  });
});
