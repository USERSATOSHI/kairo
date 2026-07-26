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
  const schemaInstruction = request.outputSchema
    ? `\n\nReturn only JSON matching this schema:\n${JSON.stringify(request.outputSchema)}`
    : '';
  return `Role: ${request.role}\n\n${request.prompt}${schemaInstruction}`;
}

function toolsFor(capabilities: readonly string[]): string {
  const tools = ['read', 'grep', 'find', 'ls'];
  if (capabilities.some((capability) => capability.includes('write'))) {
    tools.push('edit', 'write');
  }
  if (capabilities.some((capability) => capability.includes('execute'))) {
    tools.push('bash');
  }
  return tools.join(',');
}

function textFromAssistantMessage(value: Readonly<Record<string, unknown>>): string | undefined {
  if (value.role !== 'assistant' || !Array.isArray(value.content)) return undefined;
  const text = value.content
    .filter(isRecord)
    .filter((content) => content.type === 'text' && typeof content.text === 'string')
    .map((content) => content.text)
    .join('');
  return text || undefined;
}

function parseEvents(output: string): Result<HarnessExecution, HarnessError> {
  let token: string | undefined;
  let finalText: string | undefined;
  for (const line of output.split('\n').filter(Boolean)) {
    const parsed = safeCall(
      () => JSON.parse(line) as unknown,
      () => invalidResponse('Pi returned malformed JSONL', output),
    );
    if (parsed.isErr()) return parsed;
    const event = parsed.unwrap();
    if (!isRecord(event)) {
      return err(invalidResponse('Pi returned a non-object JSONL event', output));
    }
    if (event.type === 'session' && typeof event.id === 'string') token = event.id;
    if (event.type !== 'message_end' || !isRecord(event.message)) continue;
    if (
      event.message.role === 'assistant' &&
      (event.message.stopReason === 'error' || event.message.stopReason === 'aborted')
    ) {
      return err(
        processFailure(
          typeof event.message.errorMessage === 'string'
            ? event.message.errorMessage
            : `Pi request ${event.message.stopReason}`,
        ),
      );
    }
    finalText = textFromAssistantMessage(event.message) ?? finalText;
  }
  if (!finalText) {
    return err(invalidResponse('Pi response has no final assistant message', output));
  }
  return ok({
    output: parseJsonOrText(finalText),
    transcript: output,
    ...(token ? { resumeToken: token } : {}),
  });
}

/** Runs agent requests through Pi's non-interactive JSON event stream. */
export class PiHarness implements AgentHarness {
  readonly id = 'pi';

  constructor(private readonly runner: ProcessRunner = new BunProcessRunner()) {}

  execute(request: HarnessExecutionRequest): Promise<Result<HarnessExecution, HarnessError>> {
    return this.run(request, randomUUID(), '--session-id');
  }

  resume(
    request: HarnessExecutionRequest,
    token: string,
  ): Promise<Result<HarnessExecution, HarnessError>> {
    return this.run(request, token, '--session');
  }

  private async run(
    request: HarnessExecutionRequest,
    token: string,
    sessionFlag: '--session' | '--session-id',
  ): Promise<Result<HarnessExecution, HarnessError>> {
    const result = await this.runner.run(
      'pi',
      [
        '--mode',
        'json',
        sessionFlag,
        token,
        '--approve',
        '--no-extensions',
        '--no-skills',
        '--no-prompt-templates',
        '--no-themes',
        '--tools',
        toolsFor(request.capabilities),
        ...(request.model ? ['--model', request.model] : []),
        promptFor(request),
      ],
      request.workingDirectory,
    );
    if (result.isErr()) return result;
    const output = result.unwrap();
    if (output.exitCode !== 0) {
      return err(processFailure(output.stderr || `Pi exited ${output.exitCode}`));
    }
    return parseEvents(output.stdout);
  }
}
