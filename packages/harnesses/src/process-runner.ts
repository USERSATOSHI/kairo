import { fromAsync, type Result } from '@usersatoshi/results';

import type { HarnessError } from '@kairo/executors';
import { processFailure } from './errors.ts';

export interface ProcessOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessRunner {
  run(
    command: string,
    args: readonly string[],
    workingDirectory: string,
  ): Promise<Result<ProcessOutput, HarnessError>>;
}

export class BunProcessRunner implements ProcessRunner {
  async run(
    command: string,
    args: readonly string[],
    workingDirectory: string,
  ): Promise<Result<ProcessOutput, HarnessError>> {
    return fromAsync(
      async () => {
        const subprocess = Bun.spawn([command, ...args], {
          cwd: workingDirectory,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [exitCode, stdout, stderr] = await Promise.all([
          subprocess.exited,
          new Response(subprocess.stdout).text(),
          new Response(subprocess.stderr).text(),
        ]);
        return { exitCode, stdout, stderr };
      },
      (cause) =>
        processFailure(cause instanceof Error ? cause.message : 'Harness process failed to start'),
    );
  }
}
