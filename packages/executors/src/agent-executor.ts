import type { ArtifactReference, JsonValue } from '@kairo/domain';
import { err, ok, type Result } from '@usersatoshi/results';

import type {
  AgentHarnessRegistry,
  ArtifactWriter,
  ArtifactWriterError,
  HarnessError,
  HarnessExecutionRequest,
} from './ports.ts';
import { validateStructuredOutput, type StructuredOutputIssue } from './structured-output.ts';

export const enum AgentExecutorErrorKind {
  Harness = 0,
  StructuredOutput = 1,
  Artifact = 2,
}

export type AgentExecutorError =
  | {
      readonly kind: AgentExecutorErrorKind.Harness;
      readonly harnessId: string;
      readonly error: HarnessError;
    }
  | {
      readonly kind: AgentExecutorErrorKind.StructuredOutput;
      readonly harnessId: string;
      readonly issue: StructuredOutputIssue;
    }
  | {
      readonly kind: AgentExecutorErrorKind.Artifact;
      readonly error: ArtifactWriterError;
    };

export interface AgentAttemptExecution {
  readonly output: JsonValue;
  readonly resumeToken?: string;
  readonly artifacts: readonly ArtifactReference[];
}

export interface ExecuteAgentAttemptInput extends HarnessExecutionRequest {
  readonly harnessId: string;
  readonly resumeToken?: string;
}

function serializeJson(value: JsonValue): string {
  if (Array.isArray(value)) {
    return `[${value.map(serializeJson).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${serializeJson(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export class AgentExecutor {
  constructor(
    private readonly registry: AgentHarnessRegistry,
    private readonly artifactWriter: ArtifactWriter,
  ) {}

  async execute(
    input: ExecuteAgentAttemptInput,
  ): Promise<Result<AgentAttemptExecution, AgentExecutorError>> {
    const resolved = this.registry.get(input.harnessId);
    if (resolved.isErr()) {
      return err({
        kind: AgentExecutorErrorKind.Harness,
        harnessId: input.harnessId,
        error: resolved.error,
      });
    }
    const harness = resolved.unwrap();
    const request: HarnessExecutionRequest = {
      runId: input.runId,
      invocationSequence: input.invocationSequence,
      attemptNumber: input.attemptNumber,
      workingDirectory: input.workingDirectory,
      role: input.role,
      prompt: input.prompt,
      capabilities: input.capabilities,
      ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
    };
    const execution = input.resumeToken
      ? await harness.resume(request, input.resumeToken)
      : await harness.execute(request);
    if (execution.isErr()) {
      return err({
        kind: AgentExecutorErrorKind.Harness,
        harnessId: input.harnessId,
        error: execution.error,
      });
    }
    const completed = execution.unwrap();
    const validated = validateStructuredOutput(completed.output, input.outputSchema ?? true);
    if (validated.output === undefined || validated.issue) {
      return err({
        kind: AgentExecutorErrorKind.StructuredOutput,
        harnessId: input.harnessId,
        issue: validated.issue ?? { path: '$', message: 'structured output is invalid' },
      });
    }

    const artifacts: ArtifactReference[] = [];
    for (const artifact of [
      {
        kind: 'harness_transcript' as const,
        mediaType: 'application/x-ndjson',
        content: completed.transcript,
      },
      {
        kind: 'agent_output' as const,
        mediaType: 'application/json',
        content: serializeJson(validated.output),
      },
    ]) {
      const written = await this.artifactWriter.write({
        runId: input.runId,
        invocationSequence: input.invocationSequence,
        attemptNumber: input.attemptNumber,
        ...artifact,
      });
      if (written.isErr()) {
        return err({
          kind: AgentExecutorErrorKind.Artifact,
          error: written.error,
        });
      }
      artifacts.push(written.unwrap());
    }

    return ok({
      output: validated.output,
      ...(completed.resumeToken ? { resumeToken: completed.resumeToken } : {}),
      artifacts,
    });
  }
}
