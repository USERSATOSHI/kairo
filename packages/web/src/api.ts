import type {
  ApprovalDecisionRequest,
  ApprovalDecisionResponse,
  ApprovalView,
  ArtifactView,
  RunDetails,
  RunSummary,
} from '@kairo/api-contracts';

export interface ReplayedEvent {
  readonly id: number;
  readonly event: string;
  readonly data: unknown;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isRunSummary(value: unknown): value is RunSummary {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.workflowId === 'string' &&
    typeof value.status === 'string' &&
    typeof value.eventCount === 'number'
  );
}

function isRunDetails(value: unknown): value is RunDetails {
  return (
    isRecord(value) &&
    isRecord(value.state) &&
    Array.isArray(value.nodes) &&
    Array.isArray(value.edges) &&
    isRunSummary(value)
  );
}

function isApprovalView(value: unknown): value is ApprovalView {
  return (
    isRecord(value) &&
    typeof value.runId === 'string' &&
    typeof value.nodeId === 'string' &&
    typeof value.invocationSequence === 'number' &&
    isRecord(value.binding)
  );
}

function isArtifactView(value: unknown): value is ArtifactView {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.runId === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.checksum === 'string' &&
    typeof value.size === 'number'
  );
}

function isApprovalDecisionResponse(value: unknown): value is ApprovalDecisionResponse {
  return (
    isRecord(value) &&
    typeof value.runId === 'string' &&
    typeof value.invocationSequence === 'number' &&
    typeof value.status === 'string'
  );
}

async function json(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(`Kairo API request failed (${response.status})`);
  return response.json();
}

export async function fetchRuns(): Promise<readonly RunSummary[]> {
  const value = await json(await fetch('/api/runs'));
  if (!Array.isArray(value) || !value.every(isRunSummary)) {
    throw new Error('Kairo API returned malformed run summaries');
  }
  return value;
}

export async function fetchRun(runId: string): Promise<RunDetails> {
  const value = await json(await fetch(`/api/runs/${encodeURIComponent(runId)}`));
  if (!isRunDetails(value)) throw new Error('Kairo API returned malformed run details');
  return value;
}

export async function fetchApprovals(runId: string): Promise<readonly ApprovalView[]> {
  const value = await json(await fetch(`/api/runs/${encodeURIComponent(runId)}/approvals`));
  if (!Array.isArray(value) || !value.every(isApprovalView)) {
    throw new Error('Kairo API returned malformed approvals');
  }
  return value;
}

export async function fetchArtifacts(runId: string): Promise<readonly ArtifactView[]> {
  const value = await json(await fetch(`/api/runs/${encodeURIComponent(runId)}/artifacts`));
  if (!Array.isArray(value) || !value.every(isArtifactView)) {
    throw new Error('Kairo API returned malformed artifacts');
  }
  return value;
}

export async function fetchArtifact(runId: string, artifactId: string): Promise<ArtifactView> {
  const value = await json(
    await fetch(
      `/api/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
    ),
  );
  if (!isArtifactView(value)) throw new Error('Kairo API returned a malformed artifact');
  return value;
}

export async function decideApproval(
  runId: string,
  invocationSequence: number,
  request: ApprovalDecisionRequest,
): Promise<ApprovalDecisionResponse> {
  const value = await json(
    await fetch(`/api/runs/${encodeURIComponent(runId)}/approvals/${invocationSequence}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }),
  );
  if (!isApprovalDecisionResponse(value)) {
    throw new Error('Kairo API returned a malformed approval response');
  }
  return value;
}

export function reconnectEvents(
  runId: string,
  after: number,
  onEvent: (event: ReplayedEvent) => void,
): () => void {
  const source = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events?after=${after}`);
  source.addEventListener('message', (message) => {
    onEvent({
      id: Number(message.lastEventId),
      event: 'message',
      data: JSON.parse(message.data),
    });
  });
  const eventTypes = [
    'run.created',
    'run.time_observed',
    'run.paused',
    'run.resumed',
    'run.cancelled',
    'invocation.activated',
    'attempt.started',
    'attempt.resumed',
    'attempt.resume_token_recorded',
    'attempt.artifact_published',
    'run.artifact_published',
    'attempt.failed',
    'attempt.interrupted',
    'attempt.interrupt_requested',
    'invocation.retry_requested',
    'invocation.skipped',
    'invocation.completed',
    'approval.requested',
    'approval.granted',
    'approval.rejected',
    'run.completed',
  ] as const;
  for (const eventType of eventTypes) {
    source.addEventListener(eventType, (message) => {
      onEvent({
        id: Number(message.lastEventId),
        event: eventType,
        data: JSON.parse(message.data),
      });
    });
  }
  return () => source.close();
}
