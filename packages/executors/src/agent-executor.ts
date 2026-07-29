import type { ArtifactReference, JsonValue, SourceSubagentDefinition } from '@kouro/domain';
import { err, ok, type Result } from '@usersatoshi/results';

import type {
  AgentHarnessRegistry,
  ArtifactWriter,
  ArtifactWriterError,
  HarnessError,
  HarnessExecutionRequest,
  InvocationActivitySession,
  InvocationActivitySink,
  SubagentExecutionController,
  SubagentInvocationResult,
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
  readonly subagentDefinitions?: readonly ResolvedSubagentDefinition[];
}

export interface ResolvedSubagentDefinition extends SourceSubagentDefinition {
  readonly prompt: string;
  readonly outputSchemaValue?: JsonValue;
}

interface SubagentTranscriptRecord {
  readonly sequence: number;
  readonly callId: string;
  readonly subagentId: string;
  readonly harnessId: string;
  readonly model?: string;
  readonly success: boolean;
  readonly output?: JsonValue;
  readonly error?: string;
  readonly transcript?: string;
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
    private readonly activity?: InvocationActivitySink,
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
    const subagentRecords: SubagentTranscriptRecord[] = [];
    const subagents = this.createSubagentController(input, subagentRecords);
    const activitySession: InvocationActivitySession = {
      runId: input.runId,
      invocationSequence: input.invocationSequence,
      attemptNumber: input.attemptNumber,
      harnessId: input.harnessId,
      role: input.role,
      prompt: input.prompt,
    };
    await this.observeActivity(() => this.activity?.start(activitySession));
    const request: HarnessExecutionRequest = {
      runId: input.runId,
      invocationSequence: input.invocationSequence,
      attemptNumber: input.attemptNumber,
      workingDirectory: input.workingDirectory,
      role: input.role,
      prompt: input.prompt,
      capabilities: input.capabilities,
      ...(input.model === undefined ? {} : { model: input.model }),
      ...(input.outputSchema === undefined ? {} : { outputSchema: input.outputSchema }),
      ...(this.activity
        ? {
            onTranscriptChunk: (chunk: string) =>
              this.observeActivity(() => this.activity?.append(activitySession, chunk)),
          }
        : {}),
      ...(input.onResumeToken ? { onResumeToken: input.onResumeToken } : {}),
      ...(input.controls ? { controls: input.controls } : {}),
      ...(subagents ? { subagents } : {}),
    };
    const execution = await (async () => {
      try {
        return input.resumeToken
          ? await harness.resume(request, input.resumeToken)
          : await harness.execute(request);
      } finally {
        await this.observeActivity(() => this.activity?.finish(activitySession));
      }
    })();
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
        content: transcriptWithSubagents(completed.transcript, subagentRecords),
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

  private createSubagentController(
    input: ExecuteAgentAttemptInput,
    records: SubagentTranscriptRecord[],
  ): SubagentExecutionController | undefined {
    if (!input.subagentDefinitions?.length) return undefined;
    const definitions = new Map(
      input.subagentDefinitions.map((definition) => [
        definition.id,
        {
          definition,
          started: 0,
          active: 0,
        },
      ]),
    );
    let sequence = 0;
    return {
      definitions: input.subagentDefinitions.map(({ id, role }) => ({ id, role })),
      invoke: async (subagentId, task, signal) => {
        sequence += 1;
        const callSequence = sequence;
        const callId = `${subagentId}:${callSequence}`;
        const reject = (error: string, harnessId = input.harnessId): SubagentInvocationResult => {
          records.push({
            sequence: callSequence,
            callId,
            subagentId,
            harnessId,
            success: false,
            error,
          });
          return failedSubagent(callId, error);
        };
        const state = definitions.get(subagentId);
        if (!state) {
          return reject(`Subagent is not authorized: ${subagentId}`);
        }
        if (!task.trim()) {
          return reject('Subagent task must be non-empty', state.definition.harness);
        }
        if (state.started >= state.definition.maxInvocations) {
          return reject(
            `Subagent invocation limit reached: ${state.definition.maxInvocations}`,
            state.definition.harness,
          );
        }
        if (state.active >= state.definition.maxConcurrent) {
          return reject(
            `Subagent concurrency limit reached: ${state.definition.maxConcurrent}`,
            state.definition.harness,
          );
        }

        state.started += 1;
        state.active += 1;
        try {
          return await this.executeSubagent(
            input,
            state.definition,
            callSequence,
            callId,
            task,
            records,
            signal,
          );
        } finally {
          state.active -= 1;
        }
      },
    };
  }

  private async executeSubagent(
    parent: ExecuteAgentAttemptInput,
    definition: ResolvedSubagentDefinition,
    sequence: number,
    callId: string,
    task: string,
    records: SubagentTranscriptRecord[],
    signal?: AbortSignal,
  ): Promise<SubagentInvocationResult> {
    const harnessId = definition.harness ?? parent.harnessId;
    const model = definition.models?.[harnessId];
    const resolved = this.registry.get(harnessId);
    if (resolved.isErr()) {
      const error = harnessErrorText(resolved.error);
      records.push({
        sequence,
        callId,
        subagentId: definition.id,
        harnessId,
        ...(model ? { model } : {}),
        success: false,
        error,
      });
      return failedSubagent(callId, error);
    }

    const execution = await resolved.unwrap().execute({
      runId: parent.runId,
      invocationSequence: parent.invocationSequence,
      attemptNumber: parent.attemptNumber,
      workingDirectory: parent.workingDirectory,
      role: definition.role,
      prompt: `${definition.prompt}\n\nDelegated task:\n${task}`,
      capabilities: definition.capabilities,
      ...(model ? { model } : {}),
      ...(definition.outputSchemaValue === undefined
        ? {}
        : { outputSchema: definition.outputSchemaValue }),
      ...(signal ? { controls: signalControl(signal) } : {}),
    });
    if (execution.isErr()) {
      const error = harnessErrorText(execution.error);
      records.push({
        sequence,
        callId,
        subagentId: definition.id,
        harnessId,
        ...(model ? { model } : {}),
        success: false,
        error,
      });
      return failedSubagent(callId, error);
    }

    const completed = execution.unwrap();
    const validated = validateStructuredOutput(
      completed.output,
      definition.outputSchemaValue ?? true,
    );
    if (validated.output === undefined || validated.issue) {
      const error = `Subagent output is invalid at ${validated.issue?.path ?? '$'}: ${
        validated.issue?.message ?? 'structured output is invalid'
      }`;
      records.push({
        sequence,
        callId,
        subagentId: definition.id,
        harnessId,
        ...(model ? { model } : {}),
        success: false,
        error,
        transcript: completed.transcript,
      });
      return failedSubagent(callId, error);
    }

    records.push({
      sequence,
      callId,
      subagentId: definition.id,
      harnessId,
      ...(model ? { model } : {}),
      success: true,
      output: validated.output,
      transcript: completed.transcript,
    });
    return { callId, success: true, output: validated.output };
  }

  private async observeActivity(operation: () => Promise<void> | undefined): Promise<void> {
    try {
      await operation();
    } catch {
      // Live activity is best-effort and must never change attempt execution.
    }
  }
}

function failedSubagent(callId: string, error: string): SubagentInvocationResult {
  return { callId, success: false, error };
}

function harnessErrorText(error: HarnessError): string {
  if ('message' in error) return error.message;
  return `Harness cannot resume: ${error.harnessId}`;
}

function signalControl(signal: AbortSignal): HarnessExecutionRequest['controls'] {
  return {
    read: () => Promise.resolve({ steering: [], interruptRequested: signal.aborted }),
    steeringApplied: () => Promise.resolve(),
    steeringRejected: () => Promise.resolve(),
  };
}

function transcriptWithSubagents(
  parentTranscript: string,
  records: readonly SubagentTranscriptRecord[],
): string {
  if (records.length === 0) return parentTranscript;
  const nested = records
    .toSorted((left, right) => left.sequence - right.sequence)
    .map((record) => JSON.stringify({ type: 'kouro.subagent', ...record }))
    .join('\n');
  return parentTranscript ? `${parentTranscript}\n${nested}` : nested;
}
