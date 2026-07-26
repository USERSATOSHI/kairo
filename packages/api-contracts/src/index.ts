import type {
  ApprovalBinding,
  ArtifactReference,
  CompiledWorkflowBundle,
  RunEvent,
  RunState,
} from '@kairo/domain';

export interface ApiErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
}

export interface RunSummary {
  readonly id: string;
  readonly workflowId: string;
  readonly workflowVersion: string;
  readonly workflowChecksum: string;
  readonly status: RunState['status'];
  readonly startingCommit: string;
  readonly eventCount: number;
  readonly invocationCount: number;
  readonly pendingApprovalCount: number;
}

export interface RunDetails extends RunSummary {
  readonly repositoryHead: string;
  readonly state: RunState;
  readonly nodes: readonly WorkflowNodeView[];
  readonly edges: readonly WorkflowEdgeView[];
}

export interface WorkflowNodeView {
  readonly id: string;
  readonly type: CompiledWorkflowBundle['nodes'][number]['type'];
  readonly title: string;
  readonly ordinal: number;
  readonly invocations: readonly number[];
  readonly latestState?: RunState['invocations'][number]['state'];
}

export interface WorkflowEdgeView {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly outcome: string;
}

export interface WorkflowSummary {
  readonly checksum: string;
  readonly id: string;
  readonly version: string;
  readonly nodeCount: number;
}

export interface WorkflowDetails extends WorkflowSummary {
  readonly bundle: CompiledWorkflowBundle;
}

export interface RepositorySummary {
  readonly id: string;
  readonly path: string;
  readonly startingCommit?: string;
}

export interface ArtifactView extends ArtifactReference {
  readonly runId: string;
  readonly invocationSequence?: number;
  readonly attemptNumber?: number;
  readonly content?: string;
}

export interface ApprovalView {
  readonly runId: string;
  readonly nodeId: string;
  readonly invocationSequence: number;
  readonly state: RunState['invocations'][number]['state'];
  readonly binding: ApprovalBinding;
}

export interface ApprovalDecisionRequest {
  readonly decision: 'grant' | 'reject';
  readonly actor: string;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface ApprovalDecisionResponse {
  readonly runId: string;
  readonly invocationSequence: number;
  readonly status: RunState['status'];
}

export interface CreateRunRequest {
  readonly adw: string;
  readonly repositoryPath: string;
  readonly task?: string;
  readonly ticket?: string;
  readonly harnesses?: readonly string[];
  readonly harnessesByNode?: Readonly<Record<string, readonly string[]>>;
  readonly actor: string;
}

export interface CreateRunResponse {
  readonly runId: string;
  readonly status: RunState['status'];
}

export interface LifecycleRequest {
  readonly actor: string;
  readonly reason?: string;
  readonly idempotencyKey: string;
}

export interface LifecycleResponse {
  readonly runId: string;
  readonly status: RunState['status'];
}

export interface EventStreamMessage {
  readonly id: number;
  readonly event: RunEvent['type'];
  readonly data: RunEvent;
}

export interface ArtifactContent {
  readonly mediaType: string;
  readonly content: string;
}
