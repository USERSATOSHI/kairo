import { randomUUID } from 'node:crypto';

import { err, ok, safeCall, type Result } from '@usersatoshi/results';

import type {
  AgentHarness,
  HarnessError,
  HarnessExecution,
  HarnessExecutionRequest,
} from '@kairo/executors';
import { invalidResponse, processFailure } from './errors.ts';
import { BunProcessRunner, type ProcessRunner } from './process-runner.ts';

interface ParseFailure {
  readonly kind: 0;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseJsonOrText(value: string): unknown {
  const parsed = safeCall(
    () => JSON.parse(value) as unknown,
    (): ParseFailure => ({ kind: 0 }),
  );
  return parsed.isErr() ? value : parsed.unwrap();
}

function promptFor(request: HarnessExecutionRequest): string {
  return `Role: ${request.role}\n\n${request.prompt}`;
}

function toolsFor(capabilities: readonly string[]): string {
  return capabilities.some((capability) => capability.includes('write'))
    ? 'Read,Glob,Grep,Edit,Write,Bash'
    : 'Read,Glob,Grep';
}

function parseClaudeResult(
  output: string,
  fallbackToken: string,
): Result<HarnessExecution, HarnessError> {
  const parsed = safeCall(
    () => JSON.parse(output) as unknown,
    () => invalidResponse('Claude Code returned malformed JSON', output),
  );
  if (parsed.isErr()) return parsed;
  const value = parsed.unwrap();
  if (!isRecord(value)) {
    return err(invalidResponse('Claude Code returned a non-object result', output));
  }
  if (value.is_error === true) {
    return err(
      processFailure(typeof value.result === 'string' ? value.result : 'Claude Code failed'),
    );
  }
  const rawOutput = value.structured_output ?? value.result;
  if (rawOutput === undefined) {
    return err(invalidResponse('Claude Code response has no result', output));
  }
  const structured = typeof rawOutput === 'string' ? parseJsonOrText(rawOutput) : rawOutput;
  return ok({
    output: structured,
    transcript: output,
    resumeToken: typeof value.session_id === 'string' ? value.session_id : fallbackToken,
  });
}

export class ClaudeCodeHarness implements AgentHarness {
  readonly id = 'claude-code';

  constructor(private readonly runner: ProcessRunner = new BunProcessRunner()) {}

  execute(request: HarnessExecutionRequest): Promise<Result<HarnessExecution, HarnessError>> {
    const token = randomUUID();
    return this.run(request, token, [
      '-p',
      '--output-format',
      'json',
      '--session-id',
      token,
      '--permission-mode',
      'dontAsk',
      '--tools',
      toolsFor(request.capabilities),
    ]);
  }

  resume(
    request: HarnessExecutionRequest,
    token: string,
  ): Promise<Result<HarnessExecution, HarnessError>> {
    return this.run(request, token, [
      '-p',
      '--resume',
      token,
      '--output-format',
      'json',
      '--permission-mode',
      'dontAsk',
      '--tools',
      toolsFor(request.capabilities),
    ]);
  }

  private async run(
    request: HarnessExecutionRequest,
    token: string,
    baseArgs: readonly string[],
  ): Promise<Result<HarnessExecution, HarnessError>> {
    const schemaArgs = request.outputSchema
      ? ['--json-schema', JSON.stringify(request.outputSchema)]
      : [];
    const result = await this.runner.run(
      'claude',
      [...baseArgs, ...schemaArgs, promptFor(request)],
      request.workingDirectory,
    );
    if (result.isErr()) return result;
    const output = result.unwrap();
    if (output.exitCode !== 0) {
      return err(processFailure(output.stderr || `Claude Code exited ${output.exitCode}`));
    }
    return parseClaudeResult(output.stdout, token);
  }
}
