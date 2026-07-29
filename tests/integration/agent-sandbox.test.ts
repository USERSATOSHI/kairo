import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { BubblewrapAgentSandbox, SandboxErrorKind } from '@kouro/sandbox-worktree';
import {
  createOpenCodeSandboxPlugin,
  invokeOpenCodeSubagent,
} from '../../packages/harnesses/src/opencode-sandbox-plugin.ts';

describe('ADR-0030: Bubblewrap agent tool sandbox', () => {
  test('rejects lexical and symbolic-link escapes from the worktree', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kouro-agent-sandbox-path-'));
    const root = join(directory, 'worktree');
    const outside = join(directory, 'outside');
    await Bun.write(join(root, 'inside.txt'), 'inside');
    await Bun.write(join(outside, 'secret.txt'), 'secret');
    symlinkSync(outside, join(root, 'escape'));
    const sandbox = new BubblewrapAgentSandbox();
    try {
      expect((await sandbox.guardPath(root, join(root, 'inside.txt'), 'read')).isOk()).toBe(true);
      const lexical = await sandbox.guardPath(root, join(root, '..', 'outside'), 'read');
      expect(lexical.isErr()).toBe(true);
      if (lexical.isErr()) {
        expect(lexical.error.kind).toBe(SandboxErrorKind.BoundaryViolation);
      }
      const symbolic = await sandbox.guardPath(root, join(root, 'escape', 'secret.txt'), 'read');
      expect(symbolic.isErr()).toBe(true);
      if (symbolic.isErr()) {
        expect(symbolic.error.kind).toBe(SandboxErrorKind.BoundaryViolation);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('builds a minimal environment and capability-derived namespace policy', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kouro-agent-sandbox-policy-'));
    const sandbox = new BubblewrapAgentSandbox();
    try {
      const prepared = await sandbox.invocation({
        command: 'true',
        workingDirectory: root,
        writable: false,
        network: false,
        environment: {
          HOME: process.env.HOME,
          PATH: process.env.PATH,
          ANTHROPIC_API_KEY: 'must-not-cross',
        },
      });
      expect(prepared.isOk()).toBe(true);
      if (prepared.isErr()) return;
      expect(prepared.value.args).toContain('--unshare-net');
      expect(prepared.value.args).toContain('--ro-bind');
      expect(prepared.value.environment.ANTHROPIC_API_KEY).toBeUndefined();
      expect(prepared.value.environment.TMPDIR).toBe('/tmp');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('writes only through the explicitly writable worktree mount', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kouro-agent-sandbox-exec-'));
    const root = join(directory, 'worktree');
    const outside = join(directory, 'outside.txt');
    await Bun.write(join(root, '.keep'), '');
    const sandbox = new BubblewrapAgentSandbox();
    try {
      const executed = await sandbox.execute({
        command: `printf allowed > allowed.txt; printf hidden > ${outside}`,
        workingDirectory: root,
        writable: true,
        network: true,
      });
      expect(executed.isOk()).toBe(true);
      expect(readFileSync(join(root, 'allowed.txt'), 'utf8')).toBe('allowed');
      expect(await Bun.file(outside).exists()).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('rewrites OpenCode Bash calls through the Bubblewrap implementation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kouro-opencode-sandbox-plugin-'));
    try {
      const plugin = await createOpenCodeSandboxPlugin({
        workingDirectory: root,
        writable: false,
        network: false,
      })();
      const output: { args: Readonly<Record<string, unknown>> } = {
        args: { command: 'printf sandboxed' },
      };
      await plugin['tool.execute.before']({ tool: 'bash' }, output);
      expect(output.args.command).toBeString();
      expect(String(output.args.command)).toContain("'bwrap'");
      expect(String(output.args.command)).toContain("'--unshare-net'");
      expect(String(output.args.command)).toContain("'printf sandboxed'");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('exposes the authenticated OpenCode subagent tool', async () => {
    const calls: unknown[] = [];
    const configuration = {
      endpoint: 'http://127.0.0.1:7777/subagent',
      token: 'secret',
    };
    const result = await invokeOpenCodeSubagent(
      configuration,
      {
        subagent: 'scout',
        task: 'Inspect tests',
      },
      (input, init) => {
        if (typeof init.body !== 'string') {
          throw new Error('Expected the OpenCode bridge body to be JSON text');
        }
        calls.push({
          input,
          authorization: new Headers(init.headers).get('authorization'),
          body: JSON.parse(init.body),
        });
        return Promise.resolve(
          new Response(
            JSON.stringify({ callId: 'scout:1', success: true, output: { found: true } }),
          ),
        );
      },
    );
    const plugin = await createOpenCodeSandboxPlugin({
      workingDirectory: '/tmp/worktree',
      writable: false,
      network: false,
      subagents: {
        ...configuration,
        description: 'Delegate to a scout.',
      },
    })();

    expect(plugin.tool.subagent).toBeDefined();
    expect(JSON.parse(result)).toEqual({
      callId: 'scout:1',
      success: true,
      output: { found: true },
    });
    expect(calls).toEqual([
      {
        input: 'http://127.0.0.1:7777/subagent',
        authorization: 'Bearer secret',
        body: { subagent: 'scout', task: 'Inspect tests' },
      },
    ]);
  });
});
