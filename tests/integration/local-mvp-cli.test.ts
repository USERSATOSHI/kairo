import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { createLocalRequestHandler, LocalKairoHost, type LocalPaths } from '@kairo/cli';
import { compileAdwPackage, compileWorkflow } from '@kairo/adw';
import { ScriptedFakeHarness } from '@kairo/harnesses';

async function process(
  command: readonly string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn([...command], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function createRepository(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await process(['git', 'init', '--initial-branch=main'], path);
  await process(['git', 'config', 'user.name', 'Fixture'], path);
  await process(['git', 'config', 'user.email', 'fixture@example.test'], path);
  await writeFile(
    resolve(path, 'package.json'),
    `${JSON.stringify(
      {
        scripts: {
          lint: 'true',
          format: 'true',
          test: 'bun test',
        },
      },
      null,
      2,
    )}\n`,
  );
  await writeFile(
    resolve(path, 'fixture.test.ts'),
    "import { expect, test } from 'bun:test';\ntest('fixture', () => expect(1).toBe(1));\n",
  );
  await process(['git', 'add', '.'], path);
  await process(['git', 'commit', '-m', 'fixture'], path);
}

function localPaths(root: string): LocalPaths {
  const dataDirectory = resolve(root, 'data');
  return {
    dataDirectory,
    configDirectory: resolve(root, 'config'),
    databasePath: resolve(dataDirectory, 'kairo.sqlite'),
    artifactDirectory: resolve(dataDirectory, 'artifacts'),
    worktreeDirectory: resolve(dataDirectory, 'worktrees'),
  };
}

describe('M7 runnable local MVP and operator CLI', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test('fresh checkout exposes stable help and version through the binary entrypoint', async () => {
    const root = resolve(import.meta.dir, '..', '..');
    const help = await process(
      ['bun', 'run', resolve(root, 'packages', 'cli', 'src', 'main.ts'), '--help'],
      root,
    );
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain(
      'kairo create adw <name> [--template <template>] [--output <directory>]',
    );
    expect(help.stdout).toContain('feature-development, hotfix, bug-fix, chore');
    expect(help.stdout).toContain('kairo run <adw> --repo <path>');
    expect(help.stdout).toContain('kairo pause|resume|cancel <run-id>');

    const version = await process(
      ['bun', 'run', resolve(root, 'packages', 'cli', 'src', 'main.ts'), '--version'],
      root,
    );
    expect(version).toEqual({ exitCode: 0, stdout: '0.1.0\n', stderr: '' });
  });

  test('distribution bundle exposes the CLI and packaged templates', async () => {
    const root = resolve(import.meta.dir, '..', '..');
    const output = await mkdtemp(resolve(tmpdir(), 'kairo-distribution-'));
    roots.push(output);

    const built = await process(['bun', 'run', 'build:cli'], root);
    expect(built.exitCode).toBe(0);

    const binary = resolve(root, 'packages', 'cli', 'dist', 'main.js');
    const help = await process([binary, '--help'], root);
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain('Kairo 0.1.0');

    const created = await process(
      [binary, 'create', 'adw', 'packaged-cli', '--output', output],
      root,
    );
    expect(created.exitCode).toBe(0);
    expect(JSON.parse(created.stdout)).toEqual({
      name: 'packaged-cli',
      template: 'feature-development',
      path: resolve(output, 'packaged-cli'),
    });
    expect((await compileAdwPackage(resolve(output, 'packaged-cli'))).isOk()).toBe(true);
  });

  test('create adw renders every bundled template as a compilable package', async () => {
    const root = resolve(import.meta.dir, '..', '..');
    const output = await mkdtemp(resolve(root, '.kairo-adw-templates-'));
    roots.push(output);
    const templates = ['feature-development', 'hotfix', 'bug-fix', 'chore'] as const;

    for (const template of templates) {
      const name = `sample-${template}`;
      const created = await process(
        [
          'bun',
          'run',
          resolve(root, 'packages', 'cli', 'src', 'main.ts'),
          'create',
          'adw',
          name,
          '--template',
          template,
          '--output',
          output,
        ],
        root,
      );
      expect(created.exitCode).toBe(0);
      expect(JSON.parse(created.stdout)).toEqual({
        name,
        template,
        path: resolve(output, name),
      });

      const manifest = JSON.parse(await readFile(resolve(output, name, 'manifest.json'), 'utf8'));
      expect(manifest.id).toBe(name);
      expect(manifest.name).toBe(
        name
          .split('-')
          .map((part) => `${part[0]?.toUpperCase() ?? ''}${part.slice(1)}`)
          .join(' '),
      );
      expect((await compileAdwPackage(resolve(output, name))).isOk()).toBe(true);
    }
  });

  test('create adw rejects invalid names and existing target folders', async () => {
    const root = resolve(import.meta.dir, '..', '..');
    const output = await mkdtemp(resolve(tmpdir(), 'kairo-adw-reject-'));
    roots.push(output);
    const command = [
      'bun',
      'run',
      resolve(root, 'packages', 'cli', 'src', 'main.ts'),
      'create',
      'adw',
    ];

    const invalid = await process([...command, '../unsafe', '--output', output], root);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stderr).toContain('invalid_adw_name');

    const first = await process([...command, 'existing', '--output', output], root);
    expect(first.exitCode).toBe(0);
    const second = await process([...command, 'existing', '--output', output], root);
    expect(second.exitCode).toBe(1);
    expect(second.stderr).toContain('Target already exists');
  });

  test('create adw defaults to the current repository .kairo directory', async () => {
    const root = resolve(import.meta.dir, '..', '..');
    const repository = await mkdtemp(resolve(tmpdir(), 'kairo-adw-default-'));
    roots.push(repository);

    const created = await process(
      [
        'bun',
        'run',
        resolve(root, 'packages', 'cli', 'src', 'main.ts'),
        'create',
        'adw',
        'default-location',
        '--template',
        'chore',
      ],
      repository,
    );

    expect(created.exitCode).toBe(0);
    expect(JSON.parse(created.stdout).path).toBe(resolve(repository, '.kairo', 'default-location'));
    expect(
      await readFile(resolve(repository, '.kairo', 'default-location', 'manifest.json'), 'utf8'),
    ).toContain('"id": "default-location"');
  });

  test('serve router mounts JSON API under /api before the SPA fallback', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'kairo-m7-serve-'));
    roots.push(root);
    const host = new LocalKairoHost(localPaths(root), []);
    expect((await host.initialize()).isOk()).toBe(true);
    const repositoryRoot = resolve(import.meta.dir, '..', '..');
    const handle = createLocalRequestHandler(
      host.app(),
      resolve(repositoryRoot, 'packages', 'web', 'dist'),
    );
    try {
      const response = await handle(new Request('http://kairo.local/api/runs'));
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('application/json');
      expect(await response.json()).toEqual([]);

      const page = await handle(new Request('http://kairo.local/'));
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('<!doctype html>');
    } finally {
      host.dispose();
    }
  });

  test('local host diagnoses every supported harness binary', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'kairo-m7-diagnostics-'));
    roots.push(root);
    const host = new LocalKairoHost(localPaths(root));
    try {
      expect(host.harnessDiagnostics().map(({ id }) => id)).toEqual([
        'codex',
        'claude-code',
        'opencode',
        'pi',
      ]);
    } finally {
      host.dispose();
    }
  });

  test('run creation rejects a harness route that is not an agent node', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'kairo-m7-routing-'));
    roots.push(root);
    const host = new LocalKairoHost(localPaths(root), []);
    try {
      expect((await host.initialize()).isOk()).toBe(true);
      const result = await host.create({
        adw: 'feature-development',
        repositoryPath: '/not-used-for-invalid-routing',
        harnessesByNode: { missing: ['opencode'] },
        actor: 'operator',
      });
      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error.code).toBe('invalid_harness_route');
    } finally {
      host.dispose();
    }
  });

  test('packaged workflow survives restart and reaches a merge-ready branch', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'kairo-m7-'));
    roots.push(root);
    const repository = resolve(root, 'repository');
    await createRepository(repository);
    const paths = localPaths(root);
    const harness = new ScriptedFakeHarness('fake', [
      {
        output: { summary: 'Plan fixture', steps: ['Implement', 'Test'] },
        transcript: 'planned',
      },
      {
        output: { summary: 'Implemented fixture', changedFiles: [] },
        transcript: 'implemented',
      },
      {
        output: { approved: true, findings: [] },
        transcript: 'reviewed',
      },
    ]);
    const first = new LocalKairoHost(paths, [harness]);
    expect((await first.initialize()).isOk()).toBe(true);
    const created = await first.create({
      adw: 'feature-development',
      repositoryPath: repository,
      harnesses: ['fake'],
      actor: 'operator',
    });
    expect(created.isOk()).toBe(true);
    const runId = created.unwrap().runId;
    let aggregate = first.store.loadRun(runId).unwrap();
    expect(aggregate.state.status).toBe('waiting_for_approval');
    const planApproval = aggregate.state.invocations.find(
      ({ state }) => state === 'waiting_for_approval',
    );
    expect(planApproval?.approval).toBeDefined();
    if (!planApproval?.approval) throw new Error('Plan approval was not requested');

    const pauseResponse = await first.app().handle(
      new Request(`http://kairo.local/runs/${runId}/pause`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          actor: 'operator',
          idempotencyKey: 'pause:plan-approval',
        }),
      }),
    );
    expect(pauseResponse.status).toBe(200);
    const paused = first.store.loadRun(runId).unwrap();
    expect(paused.state.status).toBe('paused');
    const resumed = first
      .coordinatorFor(paused)
      .resumeRun(runId, 'operator', 'resume:plan-approval');
    expect(resumed.unwrap().state.status).toBe('waiting_for_approval');
    const approved = first
      .coordinatorFor(resumed.unwrap())
      .decideApproval(
        runId,
        planApproval.approval,
        'grant',
        'operator',
        'plan accepted',
        'approve:plan',
      );
    expect(approved.isOk()).toBe(true);
    aggregate = await first.worker.runUntilStable(runId);
    expect(aggregate.state.status).toBe('waiting_for_approval');
    first.dispose();

    const restarted = new LocalKairoHost(paths, [new ScriptedFakeHarness('fake', [])]);
    expect((await restarted.initialize()).isOk()).toBe(true);
    aggregate = restarted.store.loadRun(runId).unwrap();
    const deliveryApproval = aggregate.state.invocations.find(
      ({ state }) => state === 'waiting_for_approval',
    );
    expect(deliveryApproval?.approval).toBeDefined();
    if (!deliveryApproval?.approval) throw new Error('Delivery approval was not requested');
    const delivered = restarted
      .coordinatorFor(aggregate)
      .decideApproval(
        runId,
        deliveryApproval.approval,
        'grant',
        'operator',
        'delivery accepted',
        'approve:delivery',
      );
    expect(delivered.isOk()).toBe(true);
    aggregate = await restarted.worker.runUntilStable(runId);
    expect(aggregate.state.status).toBe('succeeded');
    expect(aggregate.state.artifacts?.map(({ kind }) => kind).toSorted()).toEqual([
      'git_diff',
      'git_status',
    ]);
    const branch = aggregate.state.configuration.deliveryBranch;
    if (typeof branch !== 'string') throw new Error('Delivery branch was not snapshotted');
    const branchCommit = await process(['git', 'rev-parse', branch], repository);
    expect(branchCommit.exitCode).toBe(0);
    expect(branchCommit.stdout.trim()).not.toBe(aggregate.state.startingCommit);

    const appRun = await restarted.app().handle(new Request(`http://kairo.local/runs/${runId}`));
    expect(appRun.status).toBe(200);
    expect((await appRun.json()).status).toBe('succeeded');
    restarted.dispose();
  });

  test('interrupt, retry, and policy-eligible skip are durable bound events', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'kairo-m7-controls-'));
    roots.push(root);
    const host = new LocalKairoHost(localPaths(root), []);
    expect((await host.initialize()).isOk()).toBe(true);
    const commandWorkflow = compileWorkflow({
      manifest: { id: 'controls', version: '1.0.0' },
      semanticVersions: { compiler: '0.1.0', ir: '1', expressions: '1' },
      entryNodeId: 'command',
      nodes: [
        {
          id: 'command',
          type: 'command',
          command: 'true',
          recoveryPolicy: 'replay_safe',
          skipOutcome: 'success',
        },
        { id: 'complete', type: 'complete' },
      ],
      transitions: [
        {
          id: 'command.success.complete',
          from: { nodeId: 'command', outcome: 'success' },
          toNodeId: 'complete',
        },
      ],
      counterLimits: {},
    });
    expect(commandWorkflow.isOk()).toBe(true);
    const coordinator = host.coordinator(root);
    let commandRun = coordinator
      .createRun({
        runId: 'interrupt-run',
        artifact: commandWorkflow.unwrap(),
        startingCommit: 'fixture',
        configuration: {},
        idempotencyKey: 'create',
      })
      .unwrap();
    commandRun = (await coordinator.advance(commandRun.runId)).unwrap();
    commandRun = host.store
      .appendEvent({
        runId: commandRun.runId,
        expectedSequence: commandRun.nextEventSequence,
        idempotencyKey: 'start',
        event: {
          type: 'attempt.started',
          invocationSequence: 1,
          attemptNumber: 1,
        },
      })
      .unwrap();
    commandRun = coordinator
      .interruptInvocation(commandRun.runId, 1, 'operator', 'stop process', 'interrupt')
      .unwrap();
    expect(commandRun.state.invocations[0]?.state).toBe('interrupted');
    commandRun = coordinator
      .retryInvocation(commandRun.runId, 1, 'operator', 'safe replay', 'retry')
      .unwrap();
    expect(commandRun.state.invocations[0]?.state).toBe('pending');
    commandRun = (await coordinator.advance(commandRun.runId)).unwrap();
    expect(commandRun.state.invocations[0]?.attempts).toHaveLength(2);
    expect(commandRun.events.map(({ type }) => type).slice(-3)).toEqual([
      'invocation.retry_requested',
      'attempt.started',
      'invocation.completed',
    ]);

    let skipRun = coordinator
      .createRun({
        runId: 'skip-run',
        artifact: commandWorkflow.unwrap(),
        startingCommit: 'fixture',
        configuration: {},
        idempotencyKey: 'create',
      })
      .unwrap();
    skipRun = (await coordinator.advance(skipRun.runId)).unwrap();
    skipRun = coordinator
      .skipInvocation(skipRun.runId, 1, 'operator', 'declared success', 'skip')
      .unwrap();
    expect(skipRun.state.invocations[0]?.outcome).toBe('success');
    const skipped = skipRun.events.at(-1);
    expect(skipped?.type).toBe('invocation.skipped');
    if (skipped?.type !== 'invocation.skipped') throw new Error('Skip event was not recorded');
    expect(skipped.binding).toEqual({
      workflowChecksum: commandWorkflow.unwrap().checksum,
      invocationSequence: 1,
      artifactChecksums: [],
      selectedOutcome: 'success',
      repositoryHead: 'fixture',
    });
    host.dispose();
  });
});
