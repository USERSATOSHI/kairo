import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { err, fromAsync, ok, safeCall, type Result } from '@usersatoshi/results';

import type {
  AgentHarness,
  HarnessError,
  HarnessExecution,
  HarnessExecutionRequest,
} from '@kouro/executors';
import { invalidResponse, processFailure } from './errors.ts';
import { BunProcessRunner, type ProcessOutput, type ProcessRunner } from './process-runner.ts';
import { parseHarnessOutput } from './structured-output.ts';

function promptFor(request: HarnessExecutionRequest): string {
  return `Role: ${request.role}\n\n${request.prompt}`;
}

function sandboxFor(capabilities: readonly string[]): 'read-only' | 'workspace-write' {
  return capabilities.some((capability) => capability.includes('write'))
    ? 'workspace-write'
    : 'read-only';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseEvents(output: string): Result<HarnessExecution, HarnessError> {
  let token: string | undefined;
  let finalText: string | undefined;
  for (const line of output.split('\n').filter(Boolean)) {
    const parsed = safeCall(
      () => JSON.parse(line) as unknown,
      () => invalidResponse('Codex returned malformed JSONL', output),
    );
    if (parsed.isErr()) return parsed;
    const event = parsed.unwrap();
    if (!isRecord(event)) {
      return err(invalidResponse('Codex returned a non-object JSONL event', output));
    }
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      token = event.thread_id;
    }
    if (event.type === 'item.completed' && isRecord(event.item)) {
      if (event.item.type === 'agent_message' && typeof event.item.text === 'string') {
        finalText = event.item.text;
      }
    }
  }
  if (!finalText) {
    return err(invalidResponse('Codex response has no final agent message', output));
  }
  return ok({
    output: parseHarnessOutput(finalText),
    transcript: output,
    ...(token ? { resumeToken: token } : {}),
  });
}

async function runWithSchema(
  runner: ProcessRunner,
  request: HarnessExecutionRequest,
  args: readonly string[],
): Promise<Result<ProcessOutput, HarnessError>> {
  if (!request.outputSchema) {
    return runner.run('codex', args, request.workingDirectory, request.onTranscriptChunk);
  }
  const directory = await mkdtemp(join(tmpdir(), 'kouro-codex-schema-'));
  const schemaPath = join(directory, 'output.schema.json');
  try {
    await writeFile(schemaPath, JSON.stringify(request.outputSchema), 'utf8');
    return await runner.run(
      'codex',
      [...args.slice(0, -1), '--output-schema', schemaPath, args.at(-1) ?? ''],
      request.workingDirectory,
      request.onTranscriptChunk,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export class CodexHarness implements AgentHarness {
  readonly id = 'codex';

  constructor(private readonly runner: ProcessRunner = new BunProcessRunner()) {}

  execute(request: HarnessExecutionRequest): Promise<Result<HarnessExecution, HarnessError>> {
    return this.run(request, [
      'exec',
      '--json',
      '-s',
      sandboxFor(request.capabilities),
      ...(request.model ? ['--model', request.model] : []),
      promptFor(request),
    ]);
  }

  resume(
    request: HarnessExecutionRequest,
    token: string,
  ): Promise<Result<HarnessExecution, HarnessError>> {
    return this.run(request, [
      'exec',
      'resume',
      '--json',
      ...(request.model ? ['--model', request.model] : []),
      token,
      promptFor(request),
    ]);
  }

  private async run(
    request: HarnessExecutionRequest,
    args: readonly string[],
  ): Promise<Result<HarnessExecution, HarnessError>> {
    const result = await fromAsync(
      () => runWithSchema(this.runner, request, args),
      (cause) =>
        processFailure(cause instanceof Error ? cause.message : 'Codex schema setup failed'),
    );
    if (result.isErr()) return result;
    const processResult = result.unwrap();
    if (processResult.isErr()) return processResult;
    const output = processResult.unwrap();
    if (output.exitCode !== 0) {
      return err(processFailure(output.stderr || `Codex exited ${output.exitCode}`));
    }
    return parseEvents(output.stdout);
  }
}
