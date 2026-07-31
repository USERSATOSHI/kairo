import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { ok } from '@usersatoshi/results';

import {
  SandboxErrorKind,
  SandboxRuntimeAgentCommandSandbox,
  WorktreePathGuard,
  type AgentCommandSandbox,
} from '@kouro/sandbox-worktree';
import {
  createOpenCodeSandboxPlugin,
  invokeOpenCodeSubagent,
} from '../../packages/harnesses/src/opencode-sandbox-plugin.ts';
import { sandboxRuntimeConfig } from '../../packages/sandbox-worktree/src/sandbox-runtime-helper.ts';

describe('ADR-0032: cross-platform agent tool sandbox', () => {
  test('rejects lexical and symbolic-link escapes from the worktree', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kouro-agent-sandbox-path-'));
    const root = join(directory, 'worktree');
    const outside = join(directory, 'outside');
    await Bun.write(join(root, 'inside.txt'), 'inside');
    await Bun.write(join(outside, 'secret.txt'), 'secret');
    symlinkSync(outside, join(root, 'escape'));
    const pathGuard = new WorktreePathGuard();
    try {
      expect((await pathGuard.guard(root, join(root, 'inside.txt'), 'read')).isOk()).toBe(true);
      const lexical = await pathGuard.guard(root, join(root, '..', 'outside'), 'read');
      expect(lexical.isErr()).toBe(true);
      if (lexical.isErr()) {
        expect(lexical.error.kind).toBe(SandboxErrorKind.BoundaryViolation);
      }
      const symbolic = await pathGuard.guard(root, join(root, 'escape', 'secret.txt'), 'read');
      expect(symbolic.isErr()).toBe(true);
      if (symbolic.isErr()) {
        expect(symbolic.error.kind).toBe(SandboxErrorKind.BoundaryViolation);
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('builds capability-derived portable filesystem and network policy', () => {
    const root = mkdtempSync(join(tmpdir(), 'kouro-agent-sandbox-policy-'));
    try {
      const config = sandboxRuntimeConfig({
        command: 'true',
        workingDirectory: root,
        writable: false,
        network: false,
        environment: {
          HOME: process.env.HOME ?? root,
          PATH: process.env.PATH ?? '',
          ANTHROPIC_API_KEY: 'must-not-cross',
        },
      });
      expect(config.network.allowedDomains).toEqual([]);
      expect(config.network.deniedDomains).toEqual(['*']);
      expect(config.filesystem.allowWrite).toEqual([]);
      expect(config.filesystem.denyWrite).toContain(root);
      expect(config.credentials?.envVars).toContainEqual({
        name: 'ANTHROPIC_API_KEY',
        mode: 'deny',
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('writes only through the explicitly writable worktree mount', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kouro-agent-sandbox-exec-'));
    const root = join(directory, 'worktree');
    const outside = join(directory, 'outside.txt');
    await Bun.write(join(root, '.keep'), '');
    const sandbox = new SandboxRuntimeAgentCommandSandbox();
    try {
      const availability = await sandbox.availability();
      if (!availability.available) {
        expect(availability.reason).toBeString();
        return;
      }
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

  test('rewrites OpenCode Bash calls through the command-sandbox port', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kouro-opencode-sandbox-plugin-'));
    try {
      const sandbox: AgentCommandSandbox = {
        id: 'test-sandbox',
        availability: () =>
          Promise.resolve({
            available: true,
            runtime: 'sandbox-runtime',
            platform: process.platform,
          }),
        invocation: () =>
          Promise.resolve(
            ok({
              command: 'kouro-sandbox-helper',
              args: ['execute', 'encoded-policy'],
              environment: { PATH: '/usr/bin' },
            }),
          ),
        execute: () => Promise.resolve(ok({ exitCode: 0 })),
      };
      const plugin = await createOpenCodeSandboxPlugin(
        {
          workingDirectory: root,
          writable: false,
          network: false,
        },
        sandbox,
      )();
      const output: { args: Readonly<Record<string, unknown>> } = {
        args: { command: 'printf sandboxed' },
      };
      await plugin['tool.execute.before']({ tool: 'bash' }, output);
      expect(output.args.command).toBeString();
      expect(String(output.args.command)).toContain("'kouro-sandbox-helper'");
      expect(String(output.args.command)).toContain("'encoded-policy'");
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
