import type {
  ArtifactReference,
  CompiledWorkflowArtifact,
  JsonValue,
  RunEvent,
  RunEventInput,
  RunState,
} from '@kouro/domain';
import type { Result } from '@usersatoshi/results';

export interface ResolvedTicket {
  readonly reference: string;
  readonly revision: string;
  readonly url?: string;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly labels?: readonly string[];
}

export const enum TicketProviderErrorKind {
  InvalidReference = 0,
  Authentication = 1,
  NotFound = 2,
  Unavailable = 3,
  InvalidResponse = 4,
}

export interface TicketProviderError {
  readonly kind: TicketProviderErrorKind;
  readonly code: string;
  readonly message: string;
}

export interface TicketProvider {
  readonly id: string;
  resolve(reference: string): Promise<Result<ResolvedTicket, TicketProviderError>>;
}

export const enum RunStoreErrorKind {
  DatabaseFailure = 0,
  RunNotFound = 1,
  RunAlreadyExists = 2,
  EventSequenceConflict = 3,
  IdempotencyConflict = 4,
  InvalidEvent = 5,
  CorruptData = 6,
  InvalidArtifact = 7,
}

export type RunStoreError =
  | {
      readonly kind: RunStoreErrorKind.DatabaseFailure;
      readonly operation: string;
      readonly message: string;
    }
  | {
      readonly kind: RunStoreErrorKind.RunNotFound;
      readonly runId: string;
    }
  | {
      readonly kind: RunStoreErrorKind.RunAlreadyExists;
      readonly runId: string;
    }
  | {
      readonly kind: RunStoreErrorKind.EventSequenceConflict;
      readonly runId: string;
      readonly expected: number;
      readonly received: number;
    }
  | {
      readonly kind: RunStoreErrorKind.IdempotencyConflict;
      readonly runId: string;
      readonly idempotencyKey: string;
    }
  | {
      readonly kind: RunStoreErrorKind.InvalidEvent;
      readonly runId: string;
      readonly error: JsonValue;
    }
  | {
      readonly kind: RunStoreErrorKind.CorruptData;
      readonly runId: string;
      readonly reason: string;
    }
  | {
      readonly kind: RunStoreErrorKind.InvalidArtifact;
      readonly runId: string;
      readonly reason: string;
    };

export interface RunAggregate {
  readonly runId: string;
  readonly artifact: CompiledWorkflowArtifact;
  readonly events: readonly RunEvent[];
  readonly state: RunState;
  readonly nextEventSequence: number;
}

export interface CreateRunInput {
  readonly runId: string;
  readonly artifact: CompiledWorkflowArtifact;
  readonly startingCommit: string;
  readonly configuration: Readonly<Record<string, JsonValue>>;
  readonly startedAt?: string;
  readonly idempotencyKey: string;
}

export interface AppendRunEventInput {
  readonly runId: string;
  readonly expectedSequence: number;
  readonly idempotencyKey: string;
  readonly event: RunEventInput;
}

export interface RunStore {
  createRun(input: CreateRunInput): Result<RunAggregate, RunStoreError>;
  loadRun(runId: string): Result<RunAggregate, RunStoreError>;
  appendEvent(input: AppendRunEventInput): Result<RunAggregate, RunStoreError>;
}

export const enum CommandRunnerErrorKind {
  ProcessFailure = 0,
}

export interface CommandRunnerError {
  readonly kind: CommandRunnerErrorKind.ProcessFailure;
  readonly message: string;
}

export interface CommandExecution {
  readonly outcome: string;
  readonly output: JsonValue;
}

export interface CommandRunner {
  execute(command: string): Promise<Result<CommandExecution, CommandRunnerError>>;
}

export interface Clock {
  now(): string;
}

export const enum HarnessErrorKind {
  Unavailable = 0,
  ProcessFailure = 1,
  InvalidResponse = 2,
  ResumeUnsupported = 3,
}

export type HarnessError =
  | {
      readonly kind: HarnessErrorKind.Unavailable | HarnessErrorKind.ProcessFailure;
      readonly message: string;
    }
  | {
      readonly kind: HarnessErrorKind.InvalidResponse;
      readonly message: string;
      readonly transcript: string;
    }
  | {
      readonly kind: HarnessErrorKind.ResumeUnsupported;
      readonly harnessId: string;
    };

export interface AgentSteeringControl {
  readonly requestSequence: number;
  readonly message: string;
}

export interface AgentControlSnapshot {
  readonly steering: readonly AgentSteeringControl[];
  readonly interruptRequested: boolean;
}

export interface AgentControlChannel {
  read(): Promise<AgentControlSnapshot>;
  steeringApplied(requestSequence: number): Promise<void>;
  steeringRejected(requestSequence: number, reason: string): Promise<void>;
}

export interface HarnessExecutionRequest {
  readonly runId: string;
  readonly invocationSequence: number;
  readonly attemptNumber: number;
  readonly workingDirectory: string;
  readonly role: string;
  readonly prompt: string;
  readonly capabilities: readonly string[];
  readonly model?: string;
  readonly outputSchema?: JsonValue;
  readonly onTranscriptChunk?: (chunk: string) => Promise<void>;
  readonly onResumeToken?: (token: string) => Promise<void>;
  readonly controls?: AgentControlChannel;
  readonly subagents?: SubagentExecutionController;
}

export interface SubagentToolDefinition {
  readonly id: string;
  readonly role: string;
}

export interface SubagentInvocationResult {
  readonly callId: string;
  readonly success: boolean;
  readonly output?: JsonValue;
  readonly error?: string;
}

export interface SubagentExecutionController {
  readonly definitions: readonly SubagentToolDefinition[];
  invoke(subagentId: string, task: string, signal?: AbortSignal): Promise<SubagentInvocationResult>;
}

export interface HarnessExecution {
  readonly output: unknown;
  readonly transcript: string;
  readonly resumeToken?: string;
}

export interface AgentHarness {
  readonly id: string;
  execute(request: HarnessExecutionRequest): Promise<Result<HarnessExecution, HarnessError>>;
  resume(
    request: HarnessExecutionRequest,
    token: string,
  ): Promise<Result<HarnessExecution, HarnessError>>;
}

export interface AgentHarnessRegistry {
  get(harnessId: string): Result<AgentHarness, HarnessError>;
}

export interface ArtifactWriteRequest {
  readonly runId: string;
  readonly invocationSequence: number;
  readonly attemptNumber: number;
  readonly kind: ArtifactReference['kind'];
  readonly mediaType: string;
  readonly content: string;
}

export const enum ArtifactWriterErrorKind {
  WriteFailure = 0,
}

export interface ArtifactWriterError {
  readonly kind: ArtifactWriterErrorKind.WriteFailure;
  readonly message: string;
}

export interface ArtifactWriter {
  write(request: ArtifactWriteRequest): Promise<Result<ArtifactReference, ArtifactWriterError>>;
}

export interface InvocationActivitySession {
  readonly runId: string;
  readonly invocationSequence: number;
  readonly attemptNumber: number;
  readonly harnessId: string;
  readonly role: string;
  readonly prompt: string;
}

export interface InvocationActivitySink {
  start(session: InvocationActivitySession): Promise<void>;
  append(session: InvocationActivitySession, chunk: string): Promise<void>;
  finish(session: InvocationActivitySession): Promise<void>;
}
