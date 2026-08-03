import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import { LocalKouroHost, type LocalPaths } from '@kouro/cli';
import { ScriptedFakeHarness } from '@kouro/harnesses';

interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

async function runProcess(
  args: readonly string[],
  cwd: string,
  environment: Readonly<Record<string, string>>,
): Promise<ProcessResult> {
  const child = Bun.spawn([...args], {
    cwd,
    env: { ...process.env, ...environment },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

async function git(args: readonly string[], cwd: string): Promise<void> {
  const child = Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' });
  if ((await child.exited) !== 0) throw new Error(`git ${args.join(' ')} failed`);
}

async function createRepository(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await git(['init', '--initial-branch=main'], path);
  await git(['config', 'user.name', 'Fixture'], path);
  await git(['config', 'user.email', 'fixture@example.test'], path);
  await writeFile(
    resolve(path, 'package.json'),
    `${JSON.stringify({ scripts: { lint: 'true', format: 'true', test: 'true' } }, null, 2)}\n`,
  );
  await git(['add', '.'], path);
  await git(['commit', '-m', 'fixture'], path);
}

function localPaths(root: string): LocalPaths {
  const dataDirectory = resolve(root, 'data');
  return {
    dataDirectory,
    configDirectory: resolve(root, 'config'),
    databasePath: resolve(dataDirectory, 'kouro.sqlite'),
    artifactDirectory: resolve(dataDirectory, 'artifacts'),
    worktreeDirectory: resolve(dataDirectory, 'worktrees'),
  };
}

describe('ticket CLI composition', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test('creates, lists, moves, comments on, and reads local tickets', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'kouro-ticket-cli-'));
    roots.push(root);
    const repositoryRoot = resolve(import.meta.dir, '..', '..');
    const cli = resolve(repositoryRoot, 'packages', 'cli', 'src', 'main.ts');
    const environment = {
      KOURO_DATA_DIR: resolve(root, 'data'),
      KOURO_CONFIG_DIR: resolve(root, 'config'),
    };
    const command = ['bun', 'run', cli, 'ticket'];
    const created = await runProcess(
      [
        ...command,
        'create',
        '--project',
        'personal',
        '--title',
        'Wire ticket CLI',
        '--description',
        'Make local tickets operable.',
        '--priority',
        'high',
        '--label',
        'cli',
      ],
      repositoryRoot,
      environment,
    );
    expect(created.exitCode).toBe(0);
    const ticket: { readonly id: string; readonly revision: number } = JSON.parse(created.stdout);

    const moved = await runProcess(
      [...command, 'move', ticket.id, '--revision', String(ticket.revision), '--status', 'ready'],
      repositoryRoot,
      environment,
    );
    expect(moved.exitCode).toBe(0);
    const ready: { readonly revision: number; readonly status: string } = JSON.parse(moved.stdout);
    expect(ready.status).toBe('ready');

    const commented = await runProcess(
      [...command, 'comment', ticket.id, '--body', 'Ready to run.'],
      repositoryRoot,
      environment,
    );
    expect(commented.exitCode).toBe(0);

    const listed = await runProcess(
      [...command, 'list', '--project', 'personal'],
      repositoryRoot,
      environment,
    );
    expect(JSON.parse(listed.stdout)).toHaveLength(1);

    const shown = await runProcess([...command, 'show', ticket.id], repositoryRoot, environment);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      id: ticket.id,
      revision: ready.revision + 1,
      status: 'ready',
      labels: ['cli'],
    });
  });

  test('reports environment-composed providers without exposing tokens', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'kouro-ticket-providers-'));
    roots.push(root);
    const previous = {
      owner: process.env.KOURO_GITHUB_OWNER,
      repository: process.env.KOURO_GITHUB_REPOSITORY,
      project: process.env.KOURO_GITHUB_PROJECT,
      token: process.env.KOURO_GITHUB_TOKEN,
    };
    process.env.KOURO_GITHUB_OWNER = 'usersatoshi';
    process.env.KOURO_GITHUB_REPOSITORY = 'kouro';
    process.env.KOURO_GITHUB_PROJECT = 'kouro';
    process.env.KOURO_GITHUB_TOKEN = 'must-not-be-returned';
    try {
      const host = new LocalKouroHost(localPaths(root), []);
      try {
        expect((await host.initialize()).isOk()).toBe(true);
        expect(host.ticketProviderConfigurations()).toContainEqual({
          id: 'github',
          displayName: 'GitHub Issues',
          configured: true,
          credentialSource: 'server_environment',
          owner: 'usersatoshi',
          repository: 'kouro',
          message: 'Configured from the KOURO_GITHUB_* environment variables.',
        });
        expect(JSON.stringify(host.ticketProviderConfigurations())).not.toContain(
          'must-not-be-returned',
        );
      } finally {
        host.dispose();
      }
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        const name = `KOURO_GITHUB_${key.toUpperCase()}`;
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test('launches a durable Kouro ticket and records its immutable run link', async () => {
    const root = await mkdtemp(resolve(tmpdir(), 'kouro-ticket-run-'));
    roots.push(root);
    const repository = resolve(root, 'repository');
    await createRepository(repository);
    const host = new LocalKouroHost(localPaths(root), [
      new ScriptedFakeHarness('fake', [
        {
          output: { summary: 'Plan from stored ticket', steps: ['Implement', 'Test'] },
          transcript: 'planned',
        },
      ]),
    ]);
    try {
      expect((await host.initialize()).isOk()).toBe(true);
      const ticket = host
        .createTicket({
          projectId: 'personal',
          title: 'Stored ticket run',
          description: 'Launch this durable ticket.',
        })
        .unwrap();
      const app = host.app(repository);
      const launch = await app.handle(
        new Request('http://kouro.test/runs', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            adw: 'feature-development',
            repositoryPath: repository,
            ticket: `kouro:${ticket.id}`,
            harnesses: ['fake'],
            actor: 'web-user',
          }),
        }),
      );
      expect(launch.status).toBe(200);
      const created: { readonly runId: string; readonly status: string } = await launch.json();
      const details = await app.handle(new Request(`http://kouro.test/tickets/${ticket.id}`));
      const body: {
        readonly runs: readonly {
          readonly ticketId: string;
          readonly runId: string;
          readonly kind: string;
          readonly createdAt: string;
        }[];
        readonly snapshots: readonly { readonly title: string; readonly runId: string }[];
      } = await details.json();
      expect(body.runs).toContainEqual(
        expect.objectContaining({
          ticketId: ticket.id,
          runId: created.runId,
          kind: 'implementation',
          createdAt: expect.any(String),
        }),
      );
      expect(body.snapshots).toContainEqual(
        expect.objectContaining({
          runId: created.runId,
          title: 'Stored ticket run',
        }),
      );
      await host.worker.runUntilStable(created.runId);
    } finally {
      host.dispose();
    }
  });
});
