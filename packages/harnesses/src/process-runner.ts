import { fromAsync, type Result } from '@usersatoshi/results';

import type { HarnessError } from '@kouro/executors';
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
    onStdout?: (chunk: string) => Promise<void>,
  ): Promise<Result<ProcessOutput, HarnessError>>;
}

async function readOutput(
  stream: ReadableStream<Uint8Array>,
  onChunk?: (chunk: string) => Promise<void>,
): Promise<string> {
  if (!onChunk) return new Response(stream).text();
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = '';
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    const chunk = decoder.decode(next.value, { stream: true });
    output += chunk;
    if (chunk) await onChunk(chunk);
  }
  const finalChunk = decoder.decode();
  output += finalChunk;
  if (finalChunk) await onChunk(finalChunk);
  return output;
}

export class BunProcessRunner implements ProcessRunner {
  async run(
    command: string,
    args: readonly string[],
    workingDirectory: string,
    onStdout?: (chunk: string) => Promise<void>,
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
          readOutput(subprocess.stdout, onStdout),
          new Response(subprocess.stderr).text(),
        ]);
        return { exitCode, stdout, stderr };
      },
      (cause) =>
        processFailure(cause instanceof Error ? cause.message : 'Harness process failed to start'),
    );
  }
}
