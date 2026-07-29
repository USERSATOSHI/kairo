import { BubblewrapAgentSandbox } from '@kouro/sandbox-worktree';
import { z } from 'zod';
import { SUBAGENT_TOOL_NAME } from './subagent-tool.ts';

interface PluginSandboxPolicy {
  readonly workingDirectory: string;
  readonly writable: boolean;
  readonly network: boolean;
  readonly subagents?: {
    readonly endpoint: string;
    readonly token: string;
    readonly description: string;
  };
}

interface OpenCodeSubagentConfiguration {
  readonly endpoint: string;
  readonly token: string;
}

type OpenCodeSubagentRequester = (input: string, init: RequestInit) => Promise<Response>;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function invokeOpenCodeSubagent(
  configuration: OpenCodeSubagentConfiguration,
  args: { readonly subagent: string; readonly task: string },
  request: OpenCodeSubagentRequester = fetch,
): Promise<string> {
  const response = await request(configuration.endpoint, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${configuration.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  return response.text();
}

export function createOpenCodeSandboxPlugin(policy: PluginSandboxPolicy) {
  const sandbox = new BubblewrapAgentSandbox();
  return async () => {
    const subagentTool = policy.subagents
      ? {
          [SUBAGENT_TOOL_NAME]: {
            description: policy.subagents.description,
            args: {
              subagent: z.string().min(1),
              task: z.string().min(1),
            },
            async execute(args: { readonly subagent: string; readonly task: string }) {
              if (!policy.subagents) throw new Error('Subagent bridge is unavailable');
              return invokeOpenCodeSubagent(policy.subagents, args);
            },
          },
        }
      : {};
    return {
      tool: subagentTool,
      'tool.execute.before': async (
        input: { readonly tool: string },
        output: { args: Readonly<Record<string, unknown>> },
      ) => {
        if (input.tool !== 'bash' || typeof output.args.command !== 'string') return;
        const invocation = await sandbox.invocation({
          ...policy,
          command: output.args.command,
          environment: process.env,
        });
        if (invocation.isErr()) {
          throw new Error(`Kouro sandbox unavailable: ${JSON.stringify(invocation.error)}`);
        }
        const prepared = invocation.unwrap();
        const environment = Object.entries(prepared.environment).map(
          ([key, value]) => `${key}=${shellQuote(value)}`,
        );
        output.args = {
          ...output.args,
          command: [
            'env',
            '-i',
            ...environment,
            shellQuote(prepared.command),
            ...prepared.args.map(shellQuote),
          ].join(' '),
        };
      },
    };
  };
}
