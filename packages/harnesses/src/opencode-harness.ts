import { err, ok, safeCall, type Result } from '@usersatoshi/results';

import type {
  AgentHarness,
  HarnessError,
  HarnessExecution,
  HarnessExecutionRequest,
} from '@kouro/executors';
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
  const schemaInstruction = request.outputSchema
    ? `\n\nReturn only JSON matching this schema:\n${JSON.stringify(request.outputSchema)}`
    : '';
  return `Role: ${request.role}\n\n${request.prompt}${schemaInstruction}`;
}

function agentFor(capabilities: readonly string[]): 'build' | 'plan' {
  return capabilities.some(
    (capability) => capability.includes('write') || capability.includes('execute'),
  )
    ? 'build'
    : 'plan';
}

function parseEvents(output: string): Result<HarnessExecution, HarnessError> {
  let token: string | undefined;
  let finalText: string | undefined;
  for (const line of output.split('\n').filter(Boolean)) {
    const parsed = safeCall(
      () => JSON.parse(line) as unknown,
      () => invalidResponse('OpenCode returned malformed JSONL', output),
    );
    if (parsed.isErr()) return parsed;
    const event = parsed.unwrap();
    if (!isRecord(event)) {
      return err(invalidResponse('OpenCode returned a non-object JSONL event', output));
    }
    if (typeof event.sessionID === 'string') token = event.sessionID;
    if (event.type === 'error') {
      return err(processFailure('OpenCode reported an execution error'));
    }
    if (event.type === 'text' && isRecord(event.part) && typeof event.part.text === 'string') {
      finalText = event.part.text;
    }
  }
  if (!finalText) {
    return err(invalidResponse('OpenCode response has no final text event', output));
  }
  return ok({
    output: parseJsonOrText(finalText),
    transcript: output,
    ...(token ? { resumeToken: token } : {}),
  });
}

/** Runs agent requests through the OpenCode CLI JSON event stream. */
export class OpenCodeHarness implements AgentHarness {
  readonly id = 'opencode';

  constructor(private readonly runner: ProcessRunner = new BunProcessRunner()) {}

  execute(request: HarnessExecutionRequest): Promise<Result<HarnessExecution, HarnessError>> {
    return this.run(request, [
      'run',
      '--format',
      'json',
      '--pure',
      '--agent',
      agentFor(request.capabilities),
      ...(request.model ? ['--model', request.model] : []),
      promptFor(request),
    ]);
  }

  resume(
    request: HarnessExecutionRequest,
    token: string,
  ): Promise<Result<HarnessExecution, HarnessError>> {
    return this.run(request, [
      'run',
      '--format',
      'json',
      '--pure',
      '--session',
      token,
      '--agent',
      agentFor(request.capabilities),
      ...(request.model ? ['--model', request.model] : []),
      promptFor(request),
    ]);
  }

  private async run(
    request: HarnessExecutionRequest,
    args: readonly string[],
  ): Promise<Result<HarnessExecution, HarnessError>> {
    const result = await this.runner.run(
      'opencode',
      args,
      request.workingDirectory,
      request.onTranscriptChunk,
    );
    if (result.isErr()) return result;
    const output = result.unwrap();
    if (output.exitCode !== 0) {
      return err(processFailure(output.stderr || `OpenCode exited ${output.exitCode}`));
    }
    return parseEvents(output.stdout);
  }
}
