import { err, fromAsync, ok, type Result } from '@usersatoshi/results';

import { SandboxErrorKind, type SandboxError, toErr } from './errors.ts';

export interface GitCommandOutput {
  readonly stdout: string;
  readonly stderr: string;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : 'Git process failed';
}

export class GitCommandRunner {
  async run(
    cwd: string,
    operation: string,
    args: readonly string[],
    environment: Readonly<Record<string, string>> = {},
  ): Promise<Result<GitCommandOutput, SandboxError>> {
    const executed = await fromAsync(
      async () => {
        const child = Bun.spawn(['git', ...args], {
          cwd,
          env: {
            ...process.env,
            ...environment,
            GIT_TERMINAL_PROMPT: '0',
          },
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        return { exitCode, stdout, stderr };
      },
      (error) =>
        toErr(SandboxErrorKind.GitFailure, {
          operation,
          exitCode: -1,
          message: messageFor(error),
        }),
    );
    if (executed.isErr()) return executed;
    const output = executed.unwrap();
    if (output.exitCode !== 0) {
      return err(
        toErr(SandboxErrorKind.GitFailure, {
          operation,
          exitCode: output.exitCode,
          message: output.stderr.trim() || 'Git process failed',
        }),
      );
    }
    return ok({
      stdout: output.stdout,
      stderr: output.stderr,
    });
  }
}
