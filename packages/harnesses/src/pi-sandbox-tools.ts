import { constants } from 'node:fs';
import { access, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';

import {
  createBashTool,
  createEditTool,
  createFindTool,
  createGrepTool,
  createLsTool,
  createReadTool,
  createWriteTool,
  defineTool,
} from '@earendil-works/pi-coding-agent';
import type { SubagentExecutionController } from '@kouro/executors';
import type { AgentCommandSandbox, WorktreePathGuard } from '@kouro/sandbox-worktree';
import { Type } from 'typebox';
import {
  SUBAGENT_TOOL_NAME,
  subagentResultText,
  subagentToolDescription,
} from './subagent-tool.ts';

export function createPiSubagentTool(subagents: SubagentExecutionController) {
  return defineTool({
    name: SUBAGENT_TOOL_NAME,
    label: 'Subagent',
    description: subagentToolDescription(subagents),
    promptSnippet: 'Delegate bounded tasks to declared workflow subagents.',
    executionMode: 'parallel',
    parameters: Type.Object({
      subagent: Type.String({ minLength: 1 }),
      task: Type.String({ minLength: 1 }),
    }),
    async execute(_toolCallId, { subagent, task }, signal) {
      return invokePiSubagent(subagents, subagent, task, signal);
    },
  });
}

export async function invokePiSubagent(
  subagents: SubagentExecutionController,
  subagent: string,
  task: string,
  signal?: AbortSignal,
) {
  const result = await subagents.invoke(subagent, task, signal);
  return {
    content: [{ type: 'text' as const, text: subagentResultText(result) }],
    details: undefined,
  };
}

function failure(error: unknown): Error {
  return new Error(
    error instanceof Error ? error.message : `Sandbox rejected operation: ${JSON.stringify(error)}`,
  );
}

async function guardedPath(
  pathGuard: WorktreePathGuard,
  root: string,
  path: string,
  operation: 'read' | 'write',
): Promise<string> {
  const guarded = await pathGuard.guard(root, path, operation);
  if (guarded.isErr()) throw failure(guarded.error);
  return guarded.unwrap();
}

function createSandboxedReadTool(root: string, pathGuard: WorktreePathGuard) {
  return createReadTool(root, {
    operations: {
      async access(path) {
        await access(await guardedPath(pathGuard, root, path, 'read'), constants.R_OK);
      },
      async readFile(path) {
        return readFile(await guardedPath(pathGuard, root, path, 'read'));
      },
    },
  });
}

function createSandboxedEditTool(root: string, pathGuard: WorktreePathGuard) {
  return createEditTool(root, {
    operations: {
      async access(path) {
        await access(
          await guardedPath(pathGuard, root, path, 'write'),
          constants.R_OK | constants.W_OK,
        );
      },
      async readFile(path) {
        return readFile(await guardedPath(pathGuard, root, path, 'read'));
      },
      async writeFile(path, content) {
        await writeFile(await guardedPath(pathGuard, root, path, 'write'), content);
      },
    },
  });
}

function createSandboxedWriteTool(root: string, pathGuard: WorktreePathGuard) {
  return createWriteTool(root, {
    operations: {
      async mkdir(path) {
        await mkdir(await guardedPath(pathGuard, root, path, 'write'), { recursive: true });
      },
      async writeFile(path, content) {
        await writeFile(await guardedPath(pathGuard, root, path, 'write'), content);
      },
    },
  });
}

function createSandboxedLsTool(root: string, pathGuard: WorktreePathGuard) {
  return createLsTool(root, {
    operations: {
      async exists(path) {
        try {
          await access(await guardedPath(pathGuard, root, path, 'read'));
          return true;
        } catch {
          return false;
        }
      },
      async stat(path) {
        return stat(await guardedPath(pathGuard, root, path, 'read'));
      },
      async readdir(path) {
        return readdir(await guardedPath(pathGuard, root, path, 'read'));
      },
    },
  });
}

function createSandboxedGrepTool(root: string, pathGuard: WorktreePathGuard) {
  return createGrepTool(root, {
    operations: {
      async isDirectory(path) {
        return (await stat(await guardedPath(pathGuard, root, path, 'read'))).isDirectory();
      },
      async readFile(path) {
        return readFile(await guardedPath(pathGuard, root, path, 'read'), 'utf8');
      },
    },
  });
}

function createSandboxedFindTool(root: string, pathGuard: WorktreePathGuard) {
  return createFindTool(root, {
    operations: {
      async exists(path) {
        try {
          await access(await guardedPath(pathGuard, root, path, 'read'));
          return true;
        } catch {
          return false;
        }
      },
      async glob(pattern, cwd, options) {
        const directory = await guardedPath(pathGuard, root, cwd, 'read');
        const matches: string[] = [];
        const glob = new Bun.Glob(pattern);
        for await (const match of glob.scan({
          cwd: directory,
          absolute: true,
          dot: true,
          onlyFiles: false,
        })) {
          if (match.includes('/node_modules/') || match.includes('/.git/')) continue;
          matches.push(match);
          if (matches.length >= options.limit) break;
        }
        return matches;
      },
    },
  });
}

function createSandboxedBashTool(
  root: string,
  pathGuard: WorktreePathGuard,
  commandSandbox: AgentCommandSandbox,
  writable: boolean,
  network: boolean,
) {
  return createBashTool(root, {
    exposeSessionEnvironment: false,
    operations: {
      async exec(command, cwd, options) {
        const guardedCwd = await guardedPath(pathGuard, root, cwd, 'read');
        const executed = await commandSandbox.execute({
          command,
          workingDirectory: guardedCwd,
          writable,
          network,
          ...(options.env ? { environment: options.env } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.timeout ? { timeoutSeconds: options.timeout } : {}),
          onData: options.onData,
        });
        if (executed.isErr()) throw failure(executed.error);
        return executed.unwrap();
      },
    },
  });
}

export function createPiSandboxTools(
  root: string,
  capabilities: readonly string[],
  pathGuard: WorktreePathGuard,
  commandSandbox: AgentCommandSandbox,
  subagents?: SubagentExecutionController,
) {
  const writable = capabilities.some((capability) => capability.includes('write'));
  const executable = capabilities.some((capability) => capability.includes('execute'));
  const network = capabilities.some((capability) => capability.includes('network'));
  return [
    createSandboxedReadTool(root, pathGuard),
    createSandboxedGrepTool(root, pathGuard),
    createSandboxedFindTool(root, pathGuard),
    createSandboxedLsTool(root, pathGuard),
    ...(writable
      ? [createSandboxedEditTool(root, pathGuard), createSandboxedWriteTool(root, pathGuard)]
      : []),
    ...(executable
      ? [createSandboxedBashTool(root, pathGuard, commandSandbox, writable, network)]
      : []),
    ...(subagents ? [createPiSubagentTool(subagents)] : []),
  ];
}
