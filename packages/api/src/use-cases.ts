import type {
  ApprovalDecisionRequest,
  ApprovalDecisionResponse,
  ApprovalView,
  ArtifactView,
  CreateRunRequest,
  CreateRunResponse,
  EventStreamMessage,
  LifecycleRequest,
  LifecycleResponse,
  RepositorySummary,
  RunDetails,
  RunSummary,
  WorkflowDetails,
  WorkflowEdgeView,
  WorkflowNodeView,
  WorkflowSummary,
} from '@kairo/api-contracts';
import type { ArtifactReference, NodeInvocation } from '@kairo/domain';
import {
  RunStoreErrorKind,
  type RunAggregate,
  type RunCoordinator,
  type RunStoreError,
} from '@kairo/executors';
import { ok, type Result } from '@usersatoshi/results';

import { ApiErrorKind, apiErr, type ApiError } from './errors.ts';
import type {
  ArtifactContentReader,
  LocalRunCreator,
  ObservableRunStore,
  RepositoryQuery,
} from './ports.ts';

export interface ApiServices {
  readonly runs: ObservableRunStore;
  readonly coordinator: RunCoordinator;
  readonly artifacts?: ArtifactContentReader;
  readonly repositories?: RepositoryQuery;
  readonly runCreator?: LocalRunCreator;
}

function fromStore<T>(result: Result<T, RunStoreError>): Result<T, ApiError> {
  if (result.isOk()) return result;
  const error = result.error;
  if (error.kind === RunStoreErrorKind.RunNotFound) {
    return apiErr(ApiErrorKind.NotFound, 'run_not_found', `Run ${error.runId} was not found`);
  }
  return apiErr(ApiErrorKind.Persistence, 'run_store_failure', 'Run state could not be read');
}

function pendingApprovalCount(invocations: readonly NodeInvocation[]): number {
  return invocations.filter(
    ({ state, approval }) => state === 'waiting_for_approval' && approval !== undefined,
  ).length;
}

function summarizeRun(aggregate: RunAggregate): RunSummary {
  return {
    id: aggregate.runId,
    workflowId: aggregate.artifact.bundle.manifest.id,
    workflowVersion: aggregate.artifact.bundle.manifest.version,
    workflowChecksum: aggregate.artifact.checksum,
    status: aggregate.state.status,
    startingCommit: aggregate.state.startingCommit,
    eventCount: aggregate.events.length,
    invocationCount: aggregate.state.invocations.length,
    pendingApprovalCount: pendingApprovalCount(aggregate.state.invocations),
  };
}

function workflowNodes(aggregate: RunAggregate): readonly WorkflowNodeView[] {
  return aggregate.artifact.bundle.nodes.map((node) => {
    const invocations = aggregate.state.invocations.filter(({ nodeId }) => nodeId === node.id);
    const latest = invocations.at(-1);
    return {
      id: node.id,
      type: node.type,
      title: node.title ?? node.id,
      ordinal: node.ordinal,
      invocations: invocations.map(({ sequence }) => sequence),
      ...(latest ? { latestState: latest.state } : {}),
    };
  });
}

function workflowEdges(aggregate: RunAggregate): readonly WorkflowEdgeView[] {
  return aggregate.artifact.bundle.transitions.map((transition) => ({
    id: transition.id,
    source: transition.from.nodeId,
    target: transition.toNodeId,
    outcome: transition.from.outcome,
  }));
}

function findArtifact(
  aggregate: RunAggregate,
  artifactId: string,
): {
  readonly artifact: ArtifactReference;
  readonly invocationSequence?: number;
  readonly attemptNumber?: number;
} | null {
  const runArtifact = aggregate.state.artifacts?.find(({ id }) => id === artifactId);
  if (runArtifact) return { artifact: runArtifact };
  for (const invocation of aggregate.state.invocations) {
    for (const attempt of invocation.attempts) {
      const artifact = attempt.artifacts?.find(({ id }) => id === artifactId);
      if (artifact) {
        return {
          artifact,
          invocationSequence: invocation.sequence,
          attemptNumber: attempt.number,
        };
      }
    }
  }
  return null;
}

function artifactView(
  runId: string,
  match: NonNullable<ReturnType<typeof findArtifact>>,
): ArtifactView {
  return {
    ...match.artifact,
    runId,
    ...(match.invocationSequence === undefined
      ? {}
      : { invocationSequence: match.invocationSequence }),
    ...(match.attemptNumber === undefined ? {} : { attemptNumber: match.attemptNumber }),
  };
}

export function listRuns(services: ApiServices): Result<readonly RunSummary[], ApiError> {
  const listed = fromStore(services.runs.listRuns());
  return listed.isErr() ? listed : ok(listed.unwrap().map(summarizeRun));
}

export function getRun(services: ApiServices, runId: string): Result<RunDetails, ApiError> {
  const loaded = fromStore(services.runs.loadRun(runId));
  if (loaded.isErr()) return loaded;
  const aggregate = loaded.unwrap();
  return ok({
    ...summarizeRun(aggregate),
    repositoryHead: aggregate.state.repositoryHead,
    state: aggregate.state,
    nodes: workflowNodes(aggregate),
    edges: workflowEdges(aggregate),
  });
}

export function listEvents(
  services: ApiServices,
  runId: string,
  after: number,
): Result<readonly EventStreamMessage[], ApiError> {
  if (!Number.isSafeInteger(after) || after < 0) {
    return apiErr(
      ApiErrorKind.InvalidInput,
      'invalid_event_sequence',
      'after must be non-negative',
    );
  }
  const loaded = fromStore(services.runs.loadRun(runId));
  return loaded.isErr()
    ? loaded
    : ok(
        loaded
          .unwrap()
          .events.filter(({ sequence }) => sequence > after)
          .map((event) => ({ id: event.sequence, event: event.type, data: event })),
      );
}

export function listArtifacts(
  services: ApiServices,
  runId: string,
): Result<readonly ArtifactView[], ApiError> {
  const loaded = fromStore(services.runs.loadRun(runId));
  if (loaded.isErr()) return loaded;
  const aggregate = loaded.unwrap();
  const artifacts: ArtifactView[] = [];
  for (const artifact of aggregate.state.artifacts ?? []) {
    artifacts.push(artifactView(runId, { artifact }));
  }
  for (const invocation of aggregate.state.invocations) {
    for (const attempt of invocation.attempts) {
      for (const artifact of attempt.artifacts ?? []) {
        artifacts.push(
          artifactView(runId, {
            artifact,
            invocationSequence: invocation.sequence,
            attemptNumber: attempt.number,
          }),
        );
      }
    }
  }
  return ok(artifacts);
}

export async function getArtifact(
  services: ApiServices,
  runId: string,
  artifactId: string,
): Promise<Result<ArtifactView, ApiError>> {
  const loaded = fromStore(services.runs.loadRun(runId));
  if (loaded.isErr()) return loaded;
  const match = findArtifact(loaded.unwrap(), artifactId);
  if (!match) {
    return apiErr(
      ApiErrorKind.NotFound,
      'artifact_not_found',
      `Artifact ${artifactId} was not found`,
    );
  }
  const view = artifactView(runId, match);
  if (!services.artifacts) return ok(view);
  const content = await services.artifacts.read(
    runId,
    match.artifact,
    match.invocationSequence,
    match.attemptNumber,
  );
  return content.isErr()
    ? apiErr(ApiErrorKind.ArtifactRead, 'artifact_read_failed', content.error.message)
    : ok({ ...view, content: content.unwrap().content });
}

export function listApprovals(
  services: ApiServices,
  runId: string,
): Result<readonly ApprovalView[], ApiError> {
  const loaded = fromStore(services.runs.loadRun(runId));
  if (loaded.isErr()) return loaded;
  const aggregate = loaded.unwrap();
  return ok(
    aggregate.state.invocations.flatMap((invocation) =>
      invocation.approval
        ? [
            {
              runId,
              nodeId: invocation.nodeId,
              invocationSequence: invocation.sequence,
              state: invocation.state,
              binding: invocation.approval,
            },
          ]
        : [],
    ),
  );
}

export function decideApproval(
  services: ApiServices,
  runId: string,
  invocationSequence: number,
  request: ApprovalDecisionRequest,
): Result<ApprovalDecisionResponse, ApiError> {
  if (!request.actor.trim() || !request.reason.trim() || !request.idempotencyKey.trim()) {
    return apiErr(
      ApiErrorKind.InvalidInput,
      'invalid_approval_decision',
      'actor, reason, and idempotencyKey are required',
    );
  }
  const loaded = fromStore(services.runs.loadRun(runId));
  if (loaded.isErr()) return loaded;
  const invocation = loaded
    .unwrap()
    .state.invocations.find(({ sequence }) => sequence === invocationSequence);
  if (invocation?.state !== 'waiting_for_approval' || !invocation.approval) {
    return apiErr(
      ApiErrorKind.Conflict,
      'approval_not_pending',
      `Invocation ${invocationSequence} is not waiting for approval`,
    );
  }
  const decided = services.coordinator.decideApproval(
    runId,
    invocation.approval,
    request.decision,
    request.actor,
    request.reason,
    request.idempotencyKey,
  );
  if (decided.isErr()) {
    return apiErr(
      ApiErrorKind.Conflict,
      'approval_decision_failed',
      'Approval could not be decided',
    );
  }
  return ok({
    runId,
    invocationSequence,
    status: decided.unwrap().state.status,
  });
}

export async function createRun(
  services: ApiServices,
  request: CreateRunRequest,
): Promise<Result<CreateRunResponse, ApiError>> {
  const task = request.task?.trim();
  const ticket = request.ticket?.trim();
  if (
    !services.runCreator ||
    !request.adw.trim() ||
    !request.repositoryPath.trim() ||
    !request.actor.trim() ||
    (request.task !== undefined && !task) ||
    (request.ticket !== undefined && !ticket) ||
    (task !== undefined && ticket !== undefined) ||
    (request.adw === 'feature-development' && task === undefined && ticket === undefined)
  ) {
    return apiErr(
      ApiErrorKind.InvalidInput,
      'invalid_run_request',
      'adw, repositoryPath, actor, and exactly one feature-development work item are required',
    );
  }
  const created = await services.runCreator.create(request);
  return created.isErr()
    ? apiErr(ApiErrorKind.Conflict, 'run_creation_failed', created.error.message)
    : created;
}

export function controlRun(
  services: ApiServices,
  runId: string,
  action: 'pause' | 'resume' | 'cancel',
  request: LifecycleRequest,
): Result<LifecycleResponse, ApiError> {
  if (!request.actor.trim() || !request.idempotencyKey.trim()) {
    return apiErr(
      ApiErrorKind.InvalidInput,
      'invalid_lifecycle_request',
      'actor and idempotencyKey are required',
    );
  }
  const result =
    action === 'pause'
      ? services.coordinator.pauseRun(runId, request.actor, request.idempotencyKey)
      : action === 'resume'
        ? services.coordinator.resumeRun(runId, request.actor, request.idempotencyKey)
        : services.coordinator.cancelRun(
            runId,
            request.actor,
            request.reason ?? 'cancelled by operator',
            request.idempotencyKey,
          );
  return result.isErr()
    ? apiErr(ApiErrorKind.Conflict, 'lifecycle_action_failed', `Run could not be ${action}d`)
    : ok({ runId, status: result.unwrap().state.status });
}

export function controlInvocation(
  services: ApiServices,
  runId: string,
  invocationSequence: number,
  action: 'interrupt' | 'retry' | 'skip',
  request: LifecycleRequest,
): Result<LifecycleResponse, ApiError> {
  if (!request.actor.trim() || !request.reason?.trim() || !request.idempotencyKey.trim()) {
    return apiErr(
      ApiErrorKind.InvalidInput,
      'invalid_lifecycle_request',
      'actor, reason, and idempotencyKey are required',
    );
  }
  const result =
    action === 'interrupt'
      ? services.coordinator.interruptInvocation(
          runId,
          invocationSequence,
          request.actor,
          request.reason,
          request.idempotencyKey,
        )
      : action === 'retry'
        ? services.coordinator.retryInvocation(
            runId,
            invocationSequence,
            request.actor,
            request.reason,
            request.idempotencyKey,
          )
        : services.coordinator.skipInvocation(
            runId,
            invocationSequence,
            request.actor,
            request.reason,
            request.idempotencyKey,
          );
  return result.isErr()
    ? apiErr(
        ApiErrorKind.Conflict,
        'invocation_action_failed',
        `Invocation could not be ${action}ed`,
      )
    : ok({ runId, status: result.unwrap().state.status });
}

export function listWorkflows(services: ApiServices): Result<readonly WorkflowSummary[], ApiError> {
  const listed = fromStore(services.runs.listRuns());
  if (listed.isErr()) return listed;
  const workflows = new Map<string, WorkflowSummary>();
  for (const aggregate of listed.unwrap()) {
    workflows.set(aggregate.artifact.checksum, {
      checksum: aggregate.artifact.checksum,
      id: aggregate.artifact.bundle.manifest.id,
      version: aggregate.artifact.bundle.manifest.version,
      nodeCount: aggregate.artifact.bundle.nodes.length,
    });
  }
  return ok([...workflows.values()].toSorted((left, right) => left.id.localeCompare(right.id)));
}

export function getWorkflow(
  services: ApiServices,
  checksum: string,
): Result<WorkflowDetails, ApiError> {
  const listed = fromStore(services.runs.listRuns());
  if (listed.isErr()) return listed;
  const aggregate = listed.unwrap().find(({ artifact }) => artifact.checksum === checksum);
  return aggregate
    ? ok({
        checksum,
        id: aggregate.artifact.bundle.manifest.id,
        version: aggregate.artifact.bundle.manifest.version,
        nodeCount: aggregate.artifact.bundle.nodes.length,
        bundle: aggregate.artifact.bundle,
      })
    : apiErr(ApiErrorKind.NotFound, 'workflow_not_found', `Workflow ${checksum} was not found`);
}

export async function listRepositories(
  services: ApiServices,
): Promise<readonly RepositorySummary[]> {
  return services.repositories?.list() ?? [];
}

export async function getRepository(
  services: ApiServices,
  repositoryId: string,
): Promise<Result<RepositorySummary, ApiError>> {
  const repositories = await listRepositories(services);
  const repository = repositories.find(({ id }) => id === repositoryId);
  return repository
    ? ok(repository)
    : apiErr(
        ApiErrorKind.NotFound,
        'repository_not_found',
        `Repository ${repositoryId} was not found`,
      );
}
