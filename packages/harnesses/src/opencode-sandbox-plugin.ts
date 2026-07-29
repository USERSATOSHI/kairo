import { BubblewrapAgentSandbox } from '@kouro/sandbox-worktree';

interface PluginSandboxPolicy {
  readonly workingDirectory: string;
  readonly writable: boolean;
  readonly network: boolean;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function createOpenCodeSandboxPlugin(policy: PluginSandboxPolicy) {
  const sandbox = new BubblewrapAgentSandbox();
  return async () => ({
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
  });
}
