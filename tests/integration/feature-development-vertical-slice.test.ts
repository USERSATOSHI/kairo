import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { compileAdwPackage } from '@kouro/adw';
import {
  AgentExecutor,
  BunCommandRunner,
  RunCoordinator,
  type AgentHarness,
  type Clock,
  type CommandExecution,
  type CommandRunner,
  type CommandRunnerError,
  type HarnessError,
  type HarnessExecution,
  type HarnessExecutionRequest,
} from '@kouro/executors';
import {
  HarnessRegistry,
  LocalArtifactWriter,
  ScriptedFakeHarness,
  type ScriptedHarnessResult,
} from '@kouro/harnesses';
import { SqliteEventStore } from '@kouro/persistence-sqlite';
import { WorktreeSandboxProvider } from '@kouro/sandbox-worktree';
import { ok, type Result } from '@usersatoshi/results';

const fixedTime = '2026-07-26T00:00:00.000Z';

const fixedClock: Clock = {
  now(): string {
    return fixedTime;
  },
};

async function run(command: readonly string[], workingDirectory: string): Promise<string> {
  const subprocess = Bun.spawn([...command], {
    cwd: workingDirectory,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    subprocess.exited,
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(' ')} failed: ${stderr}`);
  }
  return stdout.trim();
}

async function createFixtureRepository(path: string): Promise<void> {
  await run(['git', 'init', '--initial-branch=main'], path);
  await run(['git', 'config', 'user.name', 'Kouro Test'], path);
  await run(['git', 'config', 'user.email', 'kouro@example.test'], path);
  await writeFile(
    resolve(path, 'package.json'),
    `${JSON.stringify(
      {
        name: 'm5-fixture',
        private: true,
        type: 'module',
        scripts: {
          format: 'true',
          lint: 'true',
          test: 'bun test feature.test.ts',
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    resolve(path, 'feature.ts'),
    "export function greeting(): string {\n  return 'not implemented';\n}\n",
  );
  await writeFile(
    resolve(path, 'feature.test.ts'),
    "import {expect, test} from 'bun:test';\nimport {greeting} from './feature.ts';\n\ntest('greets Kouro', () => {\n  expect(greeting()).toBe('hello Kouro');\n});\n",
  );
  await run(['git', 'add', '--all'], path);
  await run(['git', 'commit', '-m', 'Initial fixture'], path);
}

class FeatureHarness implements AgentHarness {
  readonly id = 'feature-fake';
  readonly calls: HarnessExecutionRequest[] = [];
  readonly resumedImplementationTokens: string[] = [];
  readonly reviewSnapshots: string[] = [];
  private implementationCount = 0;
  private reviewCount = 0;

  execute(request: HarnessExecutionRequest): Promise<Result<HarnessExecution, HarnessError>> {
    return this.respond(request);
  }

  resume(
    request: HarnessExecutionRequest,
    token: string,
  ): Promise<Result<HarnessExecution, HarnessError>> {
    if (request.role === 'implementer') {
      this.resumedImplementationTokens.push(token);
    }
    return this.respond(request);
  }

  private async respond(
    request: HarnessExecutionRequest,
  ): Promise<Result<HarnessExecution, HarnessError>> {
    this.calls.push(request);
    switch (request.role) {
      case 'planner':
        return ok({
          output: { summary: 'Implement a greeting', steps: ['Edit', 'Test', 'Review'] },
          transcript: '{"role":"planner"}',
        });
      case 'implementer': {
        this.implementationCount += 1;
        if (this.implementationCount === 1) {
          await writeFile(
            resolve(request.workingDirectory, 'feature.ts'),
            "export function greeting(): string {\n  return 'hello';\n}\n",
          );
        } else if (this.implementationCount === 2) {
          await writeFile(
            resolve(request.workingDirectory, 'feature.ts'),
            "export function greeting(): string {\n  return 'hello Kouro';\n}\n",
          );
        } else {
          await writeFile(
            resolve(request.workingDirectory, 'README.md'),
            '# Greeting\n\nReturns the Kouro greeting.\n',
          );
        }
        return ok({
          output: { summary: `Implementation pass ${this.implementationCount}` },
          transcript: '{"role":"implementer"}',
          resumeToken: 'implementation-session',
        });
      }
      case 'reviewer': {
        const before = await readFile(resolve(request.workingDirectory, 'feature.ts'), 'utf8');
        this.reviewSnapshots.push(before);
        this.reviewCount += 1;
        const reviewOutput =
          this.reviewCount === 1
            ? { approved: false, summary: 'Document the behavior' }
            : { approved: true, summary: 'Ready to deliver' };
        const after = await readFile(resolve(request.workingDirectory, 'feature.ts'), 'utf8');
        this.reviewSnapshots.push(after);
        return ok({ output: reviewOutput, transcript: '{"role":"reviewer"}' });
      }
      default:
        throw new Error(`Unexpected role: ${request.role}`);
    }
  }
}

class SequenceCommandRunner implements CommandRunner {
  constructor(private readonly outcomes: string[]) {}

  execute(): Promise<Result<CommandExecution, CommandRunnerError>> {
    const outcome = this.outcomes.shift();
    if (!outcome) throw new Error('No command outcome remains');
    return Promise.resolve(
      ok({
        outcome,
        output: {
          exitCode: outcome === 'success' ? 0 : 1,
          stdout: '',
          stderr: outcome === 'success' ? '' : 'validation failed',
        },
      }),
    );
  }
}

function initializedStore(path: string): SqliteEventStore {
  const store = new SqliteEventStore(path);
  const initialized = store.initialize();
  if (initialized.isErr()) throw new Error(JSON.stringify(initialized.error));
  return store;
}

async function runBoundedScenario(
  root: string,
  runId: string,
  commandOutcomes: string[],
  harnessOutputs: ScriptedHarnessResult[],
): Promise<ReturnType<SqliteEventStore['loadRun']>> {
  const compiled = (
    await compileAdwPackage(resolve(import.meta.dir, '../fixtures/adws/feature-development'))
  ).unwrap();
  const store = initializedStore(resolve(root, `${runId}.sqlite`));
  try {
    const harness = new ScriptedFakeHarness('bounded-fake', harnessOutputs);
    const coordinator = new RunCoordinator(
      store,
      new SequenceCommandRunner(commandOutcomes),
      new AgentExecutor(
        new HarnessRegistry([harness]),
        new LocalArtifactWriter(resolve(root, `${runId}-artifacts`)),
      ),
      root,
      fixedClock,
    );
    coordinator
      .createRun({
        runId,
        artifact: compiled,
        startingCommit: '0123456789abcdef',
        configuration: { agentHarnesses: [harness.id] },
        idempotencyKey: 'create',
        startedAt: fixedTime,
      })
      .unwrap();

    for (let step = 0; step < 80; step += 1) {
      const aggregate = store.loadRun(runId).unwrap();
      if (aggregate.state.status === 'succeeded' || aggregate.state.status === 'failed') break;
      if (aggregate.state.status === 'waiting_for_approval') {
        const approval = aggregate.state.invocations.find(
          ({ state }) => state === 'waiting_for_approval',
        )?.approval;
        if (!approval) throw new Error('Waiting run has no approval');
        coordinator
          .decideApproval(
            runId,
            approval,
            'grant',
            'bounded-reviewer',
            'Continue bounded scenario',
            `approve:${approval.invocationSequence}`,
          )
          .unwrap();
      } else {
        const advanced = await coordinator.advance(runId);
        if (advanced.isErr()) throw new Error(JSON.stringify(advanced.error));
      }
    }
    return store.loadRun(runId);
  } finally {
    store.dispose();
  }
}

function harnessResult(value: HarnessExecution): ScriptedHarnessResult {
  return ok(value);
}

describe('M5 feature-development vertical slice', () => {
  test('a restarted run produces an artifact-bound merge-ready branch', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kouro-m5-'));
    const repositoryPath = resolve(root, 'repository');
    const managementPath = resolve(root, 'management');
    const databasePath = resolve(root, 'runs.sqlite');
    const artifactPath = resolve(root, 'artifacts');
    await mkdir(repositoryPath, { recursive: true });

    let store: SqliteEventStore | undefined;
    try {
      await createFixtureRepository(repositoryPath);
      const sandbox = new WorktreeSandboxProvider(managementPath);
      const initialized = await sandbox.initialize();
      if (initialized.isErr()) throw new Error(JSON.stringify(initialized.error));
      const registered = (await sandbox.registerRepository('fixture', repositoryPath)).unwrap();
      const pinned = (await sandbox.pinStartingCommit(registered)).unwrap();
      const worktree = (await sandbox.createWorktree(pinned, 'm5-run')).unwrap();
      const compiled = (
        await compileAdwPackage(resolve(import.meta.dir, '../fixtures/adws/feature-development'))
      ).unwrap();
      const harness = new FeatureHarness();
      const writer = new LocalArtifactWriter(artifactPath);

      store = initializedStore(databasePath);
      let coordinator = new RunCoordinator(
        store,
        new BunCommandRunner(worktree.path),
        new AgentExecutor(new HarnessRegistry([harness]), writer),
        worktree.path,
        fixedClock,
      );
      coordinator
        .createRun({
          runId: 'm5-run',
          artifact: compiled,
          startingCommit: pinned.startingCommit,
          configuration: { agentHarnesses: [harness.id] },
          idempotencyKey: 'create',
          startedAt: fixedTime,
        })
        .unwrap();

      await coordinator.advance('m5-run');
      await coordinator.advance('m5-run');
      await coordinator.advance('m5-run');
      let aggregate = store.loadRun('m5-run').unwrap();
      aggregate = store
        .appendEvent({
          runId: 'm5-run',
          expectedSequence: aggregate.nextEventSequence,
          idempotencyKey: 'plan-started-before-restart',
          event: {
            type: 'attempt.started',
            invocationSequence: 2,
            attemptNumber: 1,
            harnessId: harness.id,
          },
        })
        .unwrap();
      store
        .appendEvent({
          runId: 'm5-run',
          expectedSequence: aggregate.nextEventSequence,
          idempotencyKey: 'plan-token-before-restart',
          event: {
            type: 'attempt.resume_token_recorded',
            invocationSequence: 2,
            attemptNumber: 1,
            resumeToken: 'durable-plan-session',
          },
        })
        .unwrap();
      store.dispose();

      store = initializedStore(databasePath);
      coordinator = new RunCoordinator(
        store,
        new BunCommandRunner(worktree.path),
        new AgentExecutor(new HarnessRegistry([harness]), writer),
        worktree.path,
        fixedClock,
      );
      coordinator.recoverRun('m5-run').unwrap();
      await coordinator.advance('m5-run');

      let finalArtifactsPublished = false;
      for (let step = 0; step < 80; step += 1) {
        aggregate = store.loadRun('m5-run').unwrap();
        if (aggregate.state.status === 'succeeded' || aggregate.state.status === 'failed') break;

        const pendingDelivery = aggregate.state.invocations.some(
          ({ nodeId, state }) => nodeId === 'deliveryApproval' && state === 'pending',
        );
        if (pendingDelivery && !finalArtifactsPublished) {
          const gitArtifacts = (await sandbox.captureArtifacts(worktree)).unwrap();
          const testInvocations = aggregate.state.invocations
            .filter(({ nodeId }) => nodeId === 'validate')
            .map(({ sequence, outcome, output: invocationOutput }) => ({
              sequence,
              outcome,
              output: invocationOutput,
            }));
          const requests = [
            {
              kind: 'command_output' as const,
              mediaType: 'application/json',
              content: JSON.stringify(testInvocations),
            },
            {
              kind: 'git_diff' as const,
              mediaType: 'text/x-diff',
              content: await readFile(gitArtifacts.diff.path, 'utf8'),
            },
            {
              kind: 'git_status' as const,
              mediaType: 'text/plain',
              content: await readFile(gitArtifacts.status.path, 'utf8'),
            },
          ];
          for (const request of requests) {
            const artifact = await writer.write({
              runId: 'm5-run',
              invocationSequence: 0,
              attemptNumber: 0,
              ...request,
            });
            coordinator
              .publishRunArtifact('m5-run', artifact.unwrap(), `final-artifact:${request.kind}`)
              .unwrap();
          }
          finalArtifactsPublished = true;
          continue;
        }

        if (aggregate.state.status === 'waiting_for_approval') {
          const approval = aggregate.state.invocations.find(
            ({ state }) => state === 'waiting_for_approval',
          )?.approval;
          if (!approval) throw new Error('Waiting run has no approval binding');
          coordinator
            .decideApproval(
              'm5-run',
              approval,
              'grant',
              'fixture-reviewer',
              'Fixture acceptance',
              `approve:${approval.invocationSequence}`,
            )
            .unwrap();
          continue;
        }

        const advanced = await coordinator.advance('m5-run');
        if (advanced.isErr()) throw new Error(JSON.stringify(advanced.error));
      }

      aggregate = store.loadRun('m5-run').unwrap();
      expect(aggregate.state.status).toBe('succeeded');
      expect(aggregate.state.counters).toEqual({ reviewRepair: 1, testRepair: 1 });
      expect((aggregate.state.artifacts ?? []).map(({ kind }) => kind).toSorted()).toEqual([
        'command_output',
        'git_diff',
        'git_status',
      ]);
      expect(
        aggregate.state.invocations.find(({ nodeId }) => nodeId === 'plan')?.attempts[0]?.artifacts,
      ).toHaveLength(2);
      expect(
        aggregate.state.invocations
          .filter(({ nodeId }) => nodeId === 'review')
          .every(({ attempts }) => attempts[0]?.artifacts?.length === 2),
      ).toBe(true);
      const deliveryBinding = aggregate.state.invocations.find(
        ({ nodeId }) => nodeId === 'deliveryApproval',
      )?.approval;
      const everyChecksum = [
        ...(aggregate.state.artifacts ?? []),
        ...aggregate.state.invocations.flatMap(({ attempts }) =>
          attempts.flatMap(({ artifacts }) => artifacts ?? []),
        ),
      ]
        .map(({ checksum }) => checksum)
        .toSorted();
      expect(deliveryBinding?.artifactChecksums).toEqual(everyChecksum);

      const reviewCalls = harness.calls.filter(({ role }) => role === 'reviewer');
      const implementationCalls = harness.calls.filter(({ role }) => role === 'implementer');
      expect(implementationCalls).toHaveLength(3);
      expect(harness.resumedImplementationTokens).toEqual([
        'implementation-session',
        'implementation-session',
      ]);
      expect(implementationCalls[1]?.prompt).toContain('Workflow feedback from validate (failure)');
      expect(implementationCalls[1]?.prompt).toContain('"exitCode": 1');
      expect(implementationCalls[1]?.prompt).not.toContain('Implement the approved plan');
      expect(implementationCalls[2]?.prompt).toContain('Workflow feedback from review (success)');
      expect(implementationCalls[2]?.prompt).toContain('"approved": false');
      expect(implementationCalls[2]?.prompt).not.toContain('Implement the approved plan');
      expect(reviewCalls).toHaveLength(2);
      expect(
        reviewCalls.every(({ capabilities }) => capabilities.join() === 'repository.read'),
      ).toBe(true);
      expect(harness.reviewSnapshots[0]).toBe(harness.reviewSnapshots[1]);
      expect(harness.reviewSnapshots[2]).toBe(harness.reviewSnapshots[3]);
      expect(aggregate.events.some(({ type }) => type === 'attempt.interrupted')).toBe(true);

      const prepared = (await sandbox.prepareCommit(worktree)).unwrap();
      const committed = (
        await sandbox.commitWorktree({
          worktree,
          expectedHead: prepared.head,
          expectedTree: prepared.tree,
          message: 'Implement fixture greeting',
          identity: { name: 'Kouro', email: 'kouro@example.test' },
          timestamp: fixedTime,
        })
      ).unwrap();
      await run(['git', 'branch', 'kouro/m5-run', committed.commit], repositoryPath);
      expect(await run(['git', 'rev-parse', 'kouro/m5-run'], repositoryPath)).toBe(
        committed.commit,
      );
      expect(
        await run(
          ['git', 'merge-base', '--is-ancestor', pinned.startingCommit, committed.commit],
          repositoryPath,
        ),
      ).toBe('');
    } finally {
      store?.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('validation and review feedback loops stop at exactly their declared bounds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kouro-m5-bounds-'));
    try {
      const change = (summary: string): ScriptedHarnessResult =>
        harnessResult({
          output: { summary },
          transcript: '{}',
          resumeToken: 'implementation-session',
        });
      const plan = harnessResult({
        output: { summary: 'Plan', steps: ['Implement'] },
        transcript: '{}',
      });

      const validationBound = await runBoundedScenario(
        root,
        'test-bound',
        ['success', 'failure', 'failure', 'failure', 'failure'],
        [plan, change('Implement'), change('Repair 1'), change('Repair 2'), change('Repair 3')],
      );
      expect(validationBound.unwrap().state.status).toBe('failed');
      expect(validationBound.unwrap().state.counters.testRepair).toBe(3);
      expect(
        validationBound.unwrap().state.invocations.filter(({ nodeId }) => nodeId === 'implement'),
      ).toHaveLength(4);

      const reviewBound = await runBoundedScenario(
        root,
        'review-bound',
        ['success', 'success', 'success', 'success'],
        [
          plan,
          change('Implement'),
          harnessResult({
            output: { approved: false, summary: 'Issue 1' },
            transcript: '{}',
          }),
          change('Review repair 1'),
          harnessResult({
            output: { approved: false, summary: 'Issue 2' },
            transcript: '{}',
          }),
          change('Review repair 2'),
          harnessResult({
            output: { approved: false, summary: 'Issue 3' },
            transcript: '{}',
          }),
        ],
      );
      expect(reviewBound.unwrap().state.status).toBe('failed');
      expect(reviewBound.unwrap().state.counters.reviewRepair).toBe(2);
      expect(
        reviewBound.unwrap().state.invocations.filter(({ nodeId }) => nodeId === 'implement'),
      ).toHaveLength(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
