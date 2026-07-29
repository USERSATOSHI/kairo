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
import { BubblewrapAgentSandbox } from '@kouro/sandbox-worktree';
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
  sandbox: BubblewrapAgentSandbox,
  root: string,
  path: string,
  operation: 'read' | 'write',
): Promise<string> {
  const guarded = await sandbox.guardPath(root, path, operation);
  if (guarded.isErr()) throw failure(guarded.error);
  return guarded.unwrap();
}

function createSandboxedReadTool(root: string, sandbox: BubblewrapAgentSandbox) {
  return createReadTool(root, {
    operations: {
      async access(path) {
        await access(await guardedPath(sandbox, root, path, 'read'), constants.R_OK);
      },
      async readFile(path) {
        return readFile(await guardedPath(sandbox, root, path, 'read'));
      },
    },
  });
}

function createSandboxedEditTool(root: string, sandbox: BubblewrapAgentSandbox) {
  return createEditTool(root, {
    operations: {
      async access(path) {
        await access(
          await guardedPath(sandbox, root, path, 'write'),
          constants.R_OK | constants.W_OK,
        );
      },
      async readFile(path) {
        return readFile(await guardedPath(sandbox, root, path, 'read'));
      },
      async writeFile(path, content) {
        await writeFile(await guardedPath(sandbox, root, path, 'write'), content);
      },
    },
  });
}

function createSandboxedWriteTool(root: string, sandbox: BubblewrapAgentSandbox) {
  return createWriteTool(root, {
    operations: {
      async mkdir(path) {
        await mkdir(await guardedPath(sandbox, root, path, 'write'), { recursive: true });
      },
      async writeFile(path, content) {
        await writeFile(await guardedPath(sandbox, root, path, 'write'), content);
      },
    },
  });
}

function createSandboxedLsTool(root: string, sandbox: BubblewrapAgentSandbox) {
  return createLsTool(root, {
    operations: {
      async exists(path) {
        try {
          await access(await guardedPath(sandbox, root, path, 'read'));
          return true;
        } catch {
          return false;
        }
      },
      async stat(path) {
        return stat(await guardedPath(sandbox, root, path, 'read'));
      },
      async readdir(path) {
        return readdir(await guardedPath(sandbox, root, path, 'read'));
      },
    },
  });
}

function createSandboxedGrepTool(root: string, sandbox: BubblewrapAgentSandbox) {
  return createGrepTool(root, {
    operations: {
      async isDirectory(path) {
        return (await stat(await guardedPath(sandbox, root, path, 'read'))).isDirectory();
      },
      async readFile(path) {
        return readFile(await guardedPath(sandbox, root, path, 'read'), 'utf8');
      },
    },
  });
}

function createSandboxedFindTool(root: string, sandbox: BubblewrapAgentSandbox) {
  return createFindTool(root, {
    operations: {
      async exists(path) {
        try {
          await access(await guardedPath(sandbox, root, path, 'read'));
          return true;
        } catch {
          return false;
        }
      },
      async glob(pattern, cwd, options) {
        const directory = await guardedPath(sandbox, root, cwd, 'read');
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
  sandbox: BubblewrapAgentSandbox,
  writable: boolean,
  network: boolean,
) {
  return createBashTool(root, {
    exposeSessionEnvironment: false,
    operations: {
      async exec(command, cwd, options) {
        const guardedCwd = await guardedPath(sandbox, root, cwd, 'read');
        const executed = await sandbox.execute({
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
  sandbox: BubblewrapAgentSandbox,
  subagents?: SubagentExecutionController,
) {
  const writable = capabilities.some((capability) => capability.includes('write'));
  const executable = capabilities.some((capability) => capability.includes('execute'));
  const network = capabilities.some((capability) => capability.includes('network'));
  return [
    createSandboxedReadTool(root, sandbox),
    createSandboxedGrepTool(root, sandbox),
    createSandboxedFindTool(root, sandbox),
    createSandboxedLsTool(root, sandbox),
    ...(writable
      ? [createSandboxedEditTool(root, sandbox), createSandboxedWriteTool(root, sandbox)]
      : []),
    ...(executable ? [createSandboxedBashTool(root, sandbox, writable, network)] : []),
    ...(subagents ? [createPiSubagentTool(subagents)] : []),
  ];
}
