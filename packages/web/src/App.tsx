import '@xyflow/react/dist/style.css';

import type {
  ApprovalView,
  ArtifactView,
  InvocationActivityView,
  RunDetails,
  RunSummary,
  TicketDetails,
  TicketListItem,
  TicketProjectView,
  TicketProviderConfigurationView,
  WorkflowNodeView,
} from '@kouro/api-contracts';
import type { DeliveryMetadata, DeliveryState } from '@kouro/domain';
import {
  Background,
  BaseEdge,
  Controls,
  type Edge,
  EdgeLabelRenderer,
  type EdgeProps,
  getBezierPath,
  getSmoothStepPath,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeProps,
  Position,
  ReactFlow,
} from '@xyflow/react';
import {
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  controlInvocation,
  controlRun,
  decideApproval,
  deleteRun,
  fetchApprovals,
  fetchArtifact,
  fetchArtifacts,
  fetchInvocationActivity,
  fetchRun,
  fetchRuns,
  fetchTicket,
  fetchTicketProjects,
  fetchTicketProviderConfigurations,
  fetchTickets,
  publishRun,
  reconnectEvents,
  type ReplayedEvent,
} from './api.ts';
import {
  approvalDiffArtifact,
  formatByteSize,
  invocationDisplayState,
  invocationFailure,
} from './execution-presentation.ts';
import {
  invocationControlAvailability,
  preferredInvocationSequence,
} from './execution-controls.ts';
import { newIdempotencyKey } from './idempotency-key.ts';
import {
  CodeViewer,
  MarkdownContent,
  structuredValueMarkdown,
} from './code-viewer.tsx';
import {
  groupTranscript,
  parseTranscript,
  type TranscriptEntry,
} from './transcript.ts';

type Tab = 'control' | 'details' | 'events' | 'artifacts' | 'approval';
type DiagramMode = 'flowchart' | 'graph';
type DiagramDirection = 'TB' | 'LR';

interface WorkspaceStyle extends CSSProperties {
  readonly '--inspector-height': string;
}

interface DrawerDrag {
  readonly pointerId: number;
  readonly startHeight: number;
  readonly startY: number;
}

interface WorkItemView {
  readonly provider: string;
  readonly reference: string;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly string[];
  readonly checksum: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function formattedJson(text: string): string | undefined {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return undefined;
  }
}

function jsonMarkdown(text: string): string | undefined {
  try {
    return structuredValueMarkdown(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function workItemFor(run: RunDetails): WorkItemView | undefined {
  const value = run.state.configuration.workItem;
  if (
    !isRecord(value) ||
    typeof value.provider !== 'string' ||
    typeof value.reference !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.description !== 'string' ||
    !Array.isArray(value.acceptanceCriteria) ||
    !value.acceptanceCriteria.every((criterion) => typeof criterion === 'string') ||
    typeof value.checksum !== 'string'
  ) {
    return undefined;
  }
  return {
    provider: value.provider,
    reference: value.reference,
    title: value.title,
    description: value.description,
    acceptanceCriteria: value.acceptanceCriteria,
    checksum: value.checksum,
  };
}

function stateClass(state: string): string {
  return `state state-${state.replaceAll('_', '-')}`;
}

function isTerminalRun(run: RunSummary): boolean {
  return ['succeeded', 'failed', 'cancelled'].includes(run.status);
}

function repositoryName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

interface WorkflowNodeData extends Record<string, unknown> {
  readonly title: string;
  readonly nodeType: WorkflowNodeView['type'];
  readonly state: string;
  readonly direction: DiagramDirection;
  readonly mode: DiagramMode;
}

type WorkflowFlowNode = Node<WorkflowNodeData, 'workflow'>;

function WorkflowGraphNode({ data }: NodeProps<WorkflowFlowNode>) {
  const horizontal = data.direction === 'LR' && data.mode === 'flowchart';
  return (
    <div className={`flow-node flow-node-${data.nodeType} flow-node-${data.mode}`}>
      <Handle position={horizontal ? Position.Left : Position.Top} type="target" />
      <small>{data.nodeType}</small>
      <strong>{data.title}</strong>
      <span className={stateClass(data.state)}>{data.state}</span>
      <Handle position={horizontal ? Position.Right : Position.Bottom} type="source" />
    </div>
  );
}

const workflowNodeTypes = { workflow: WorkflowGraphNode };

interface WorkflowEdgeData extends Record<string, unknown> {
  readonly direction: DiagramDirection;
  readonly label: string;
  readonly labelOffset: number;
  readonly mode: DiagramMode;
  readonly selected: boolean;
}

type WorkflowFlowEdge = Edge<WorkflowEdgeData, 'workflow'>;

function WorkflowGraphEdge({
  data,
  markerEnd,
  sourcePosition,
  sourceX,
  sourceY,
  style,
  targetPosition,
  targetX,
  targetY,
}: EdgeProps<WorkflowFlowEdge>) {
  if (!data) return null;
  const [path, labelX, labelY] =
    data.mode === 'graph'
      ? getBezierPath({
          sourceX,
          sourceY,
          sourcePosition,
          targetX,
          targetY,
          targetPosition,
        })
      : getSmoothStepPath({
          sourceX,
          sourceY,
          sourcePosition,
          targetX,
          targetY,
          targetPosition,
          borderRadius: 8,
        });
  const xOffset = data.direction === 'TB' ? data.labelOffset : 0;
  const yOffset = data.direction === 'LR' ? data.labelOffset : 0;
  return (
    <>
      <BaseEdge markerEnd={markerEnd} path={path} style={style} />
      <EdgeLabelRenderer>
        <span
          className={`flow-edge-label${data.selected ? ' selected' : ''}`}
          style={{
            transform: `translate(-50%, -50%) translate(${labelX + xOffset}px, ${labelY + yOffset}px)`,
          }}
        >
          {data.label}
        </span>
      </EdgeLabelRenderer>
    </>
  );
}

const workflowEdgeTypes = { workflow: WorkflowGraphEdge };

function graphDepths(run: RunDetails): ReadonlyMap<string, number> {
  const outgoing = new Map<string, string[]>();
  for (const edge of run.edges) {
    const targets = outgoing.get(edge.source) ?? [];
    targets.push(edge.target);
    outgoing.set(edge.source, targets);
  }
  const depths = new Map<string, number>([[run.entryNodeId, 0]]);
  const queue = [run.entryNodeId];
  for (let index = 0; index < queue.length; index += 1) {
    const source = queue[index];
    if (source === undefined) continue;
    const depth = depths.get(source) ?? 0;
    for (const target of outgoing.get(source) ?? []) {
      if (depths.has(target)) continue;
      depths.set(target, depth + 1);
      queue.push(target);
    }
  }
  const fallbackDepth = Math.max(0, ...depths.values()) + 1;
  for (const node of run.nodes) {
    if (!depths.has(node.id)) depths.set(node.id, fallbackDepth);
  }
  return depths;
}

function flowchartNodes(
  run: RunDetails,
  direction: DiagramDirection,
): WorkflowFlowNode[] {
  const depths = graphDepths(run);
  const layers = new Map<number, WorkflowNodeView[]>();
  for (const node of run.nodes) {
    const depth = depths.get(node.id) ?? 0;
    const layer = layers.get(depth) ?? [];
    layer.push(node);
    layers.set(depth, layer);
  }
  const widestLayer = Math.max(1, ...[...layers.values()].map((layer) => layer.length));
  const crossAxisGap = 270;
  const depthGap = 180;
  return [...layers.entries()].flatMap(([depth, layer]) => {
    const sorted = layer.toSorted((left, right) => left.ordinal - right.ordinal);
    const offset = ((widestLayer - sorted.length) * crossAxisGap) / 2;
    return sorted.map((node, index) => ({
      id: node.id,
      type: 'workflow',
      position:
        direction === 'TB'
          ? { x: offset + index * crossAxisGap, y: depth * depthGap }
          : { x: depth * crossAxisGap, y: offset + index * depthGap },
      data: {
        title: node.title,
        nodeType: node.type,
        state: nodeState(run, node),
        direction,
        mode: 'flowchart' as const,
      },
    }));
  });
}

function networkGraphNodes(run: RunDetails): WorkflowFlowNode[] {
  const count = Math.max(1, run.nodes.length);
  const radius = Math.max(220, count * 42);
  return run.nodes
    .toSorted((left, right) => left.ordinal - right.ordinal)
    .map((node, index) => {
      const angle = (index / count) * Math.PI * 2 - Math.PI / 2;
      return {
        id: node.id,
        type: 'workflow',
        position: {
          x: Math.cos(angle) * radius,
          y: Math.sin(angle) * radius,
        },
        data: {
          title: node.title,
          nodeType: node.type,
          state: nodeState(run, node),
          direction: 'TB' as const,
          mode: 'graph' as const,
        },
      };
    });
}

function nodeState(run: RunDetails, node: WorkflowNodeView): string {
  const latest = run.state.invocations.filter(({ nodeId }) => nodeId === node.id).at(-1);
  if (!latest) return 'pending';
  return displayedInvocationState(run, node, latest);
}

function displayedInvocationState(
  run: RunDetails,
  node: WorkflowNodeView,
  invocation: RunDetails['state']['invocations'][number],
): string {
  if (node.type === 'complete' && invocation.state === 'pending' && isTerminalRun(run)) {
    return run.status;
  }
  return invocationDisplayState(invocation);
}

function graphEdges(
  run: RunDetails,
  mode: DiagramMode,
  direction: DiagramDirection,
): WorkflowFlowEdge[] {
  const edgeDirection = mode === 'graph' ? 'TB' : direction;
  const selectedTransitions = new Set(
    run.state.invocations.flatMap(({ selectedTransitionId }) =>
      selectedTransitionId ? [selectedTransitionId] : [],
    ),
  );
  const activeNodes = new Set(
    run.nodes
      .filter(({ latestState }) => ['active', 'waiting_for_approval'].includes(latestState ?? ''))
      .map(({ id }) => id),
  );
  const outgoingCounts = new Map<string, number>();
  for (const edge of run.edges) {
    outgoingCounts.set(edge.source, (outgoingCounts.get(edge.source) ?? 0) + 1);
  }
  const sourceCounts = new Map<string, number>();
  return run.edges.map((edge) => {
    const siblingIndex = sourceCounts.get(edge.source) ?? 0;
    sourceCounts.set(edge.source, siblingIndex + 1);
    const siblingCount = outgoingCounts.get(edge.source) ?? 1;
    const labelOffset = (siblingIndex - (siblingCount - 1) / 2) * 30;
    const selected = selectedTransitions.has(edge.id);
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: 'workflow',
      animated: activeNodes.has(edge.source),
      data: {
        direction: edgeDirection,
        label: edge.outcome,
        labelOffset,
        mode,
        selected,
      },
      markerEnd: {
        type: MarkerType.ArrowClosed,
        color: selected ? '#2f81f7' : '#6e7681',
      },
      style: {
        stroke: selected ? '#2f81f7' : '#6e7681',
        strokeWidth: selected ? 2.5 : 1.5,
      },
    };
  });
}

function RunList({
  runs,
  selected,
  onSelect,
}: {
  readonly runs: readonly RunSummary[];
  readonly selected?: string;
  readonly onSelect: (id: string) => void;
}) {
  return (
    <aside className="run-list">
      <header>
        <p className="eyebrow">Current repository</p>
        <h1>Workflow runs</h1>
      </header>
      <div className="run-list-heading">
        <span>Runs</span>
        <span className="count">{runs.length}</span>
      </div>
      <nav>
        {runs.map((run) => (
          <button
            className={run.id === selected ? 'run selected' : 'run'}
            key={run.id}
            onClick={() => onSelect(run.id)}
            type="button"
          >
            <span className="run-name">{run.id}</span>
            <span className="run-meta">
              {repositoryName(run.repositoryPath)} · {run.workflowId}
            </span>
            <span className={stateClass(run.status)}>{run.status}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}

type InvocationAction = 'steer' | 'interrupt' | 'retry' | 'skip';

function OperatorConsole({
  activities,
  busy,
  run,
  selectedNodeId,
  onAction,
  onOpenActivity,
}: {
  readonly activities: Readonly<Record<number, InvocationActivityView>>;
  readonly busy: boolean;
  readonly run: RunDetails;
  readonly selectedNodeId: string | null;
  readonly onAction: (
    invocationSequence: number,
    action: InvocationAction,
    value: string,
  ) => Promise<boolean>;
  readonly onOpenActivity: (invocationSequence: number) => void;
}) {
  const preferred = preferredInvocationSequence(run, selectedNodeId);
  const [invocationSequence, setInvocationSequence] = useState<number | null>(preferred);
  const [reason, setReason] = useState('');
  useEffect(() => setInvocationSequence(preferred), [preferred, run.id]);

  const invocation =
    run.state.invocations.find(({ sequence }) => sequence === invocationSequence) ??
    run.state.invocations.at(-1);
  const node = run.nodes.find(({ id }) => id === invocation?.nodeId);
  const attempt = invocation?.attempts.at(-1);

  async function submit(action: InvocationAction, value: string): Promise<void> {
    if (!invocation || !value.trim()) return;
    const completed = await onAction(invocation.sequence, action, value.trim());
    if (!completed) return;
    setReason('');
  }

  if (!invocation) {
    return <p className="empty">No invocation is available to control yet.</p>;
  }
  const { steerable, interruptible, retryable, skippable } = invocationControlAvailability(
    run,
    invocation.sequence,
  );
  const activityAvailable = activities[invocation.sequence] !== undefined;

  return (
    <div className="operator-console">
      <section className="control-target">
        <div>
          <span className="field-label">Target invocation</span>
          <strong>{node?.title ?? invocation.nodeId}</strong>
          <small>
            {node?.type ?? 'node'} · attempt {attempt?.number ?? 'not started'}
          </small>
        </div>
        <label>
          Invocation
          <select
            onChange={(event) => setInvocationSequence(Number(event.target.value))}
            value={invocation.sequence}
          >
            {run.state.invocations
              .toReversed()
              .map((candidate) => (
                <option key={candidate.sequence} value={candidate.sequence}>
                  #{candidate.sequence} · {candidate.nodeId} · {candidate.state}
                </option>
              ))}
          </select>
        </label>
        <span className={stateClass(invocation.state)}>{invocation.state}</span>
      </section>

      <section className="agent-session-card">
        <header>
          <div>
            <span className="field-label">Agent session</span>
            <h3>{node?.type === 'agent' ? 'Follow and guide the active turn' : 'No agent turn'}</h3>
          </div>
          <span className={steerable ? 'connection-live' : 'connection-idle'}>
            {steerable ? 'live' : invocation.state.replaceAll('_', ' ')}
          </span>
        </header>
        <p>
          Open the coding-agent session to watch reasoning, tool calls, and results while adding
          steering in context.
        </p>
        <div className="session-actions">
          <small>Invocation #{invocation.sequence} · {attempt?.harnessId ?? 'native'}</small>
          <button
            className="primary-button"
            disabled={node?.type !== 'agent' || !activityAvailable || busy}
            onClick={() => onOpenActivity(invocation.sequence)}
            type="button"
          >
            {activityAvailable
              ? steerable
                ? 'Open live session'
                : 'View agent session'
              : 'Waiting for stream'}
          </button>
        </div>
      </section>

      <section className="recovery-console">
        <label>
          Operator reason
          <input
            disabled={busy}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Required for interrupt, retry, or skip"
            value={reason}
          />
        </label>
        <div className="recovery-actions">
          <button
            className="danger-button"
            disabled={!interruptible || busy || !reason.trim()}
            onClick={() => void submit('interrupt', reason)}
            type="button"
          >
            Interrupt attempt
          </button>
          <button
            disabled={!retryable || busy || !reason.trim()}
            onClick={() => void submit('retry', reason)}
            type="button"
          >
            Retry invocation
          </button>
          <button
            disabled={!skippable || busy || !reason.trim()}
            onClick={() => void submit('skip', reason)}
            title={node?.skipOutcome ? `Select outcome ${node.skipOutcome}` : 'Node is not skippable'}
            type="button"
          >
            Skip{node?.skipOutcome ? ` → ${node.skipOutcome}` : ''}
          </button>
        </div>
      </section>
    </div>
  );
}

function NodeDetails({
  node,
  run,
  artifacts,
  activities,
  onOpenActivity,
  onOpenArtifact,
}: {
  readonly node: WorkflowNodeView | null;
  readonly run: RunDetails;
  readonly artifacts: readonly ArtifactView[];
  readonly activities: Readonly<Record<number, InvocationActivityView>>;
  readonly onOpenActivity: (invocationSequence: number) => void;
  readonly onOpenArtifact: (artifact: ArtifactView) => void;
}) {
  if (!node) return <p className="empty">Select a node to inspect its durable execution state.</p>;
  const invocations = run.state.invocations.filter(({ nodeId }) => nodeId === node.id);
  const workItem = workItemFor(run);
  return (
    <div className="detail-stack">
      {workItem ? (
        <article className="definition work-item">
          <span className="node-type">
            {workItem.provider} · {workItem.reference}
          </span>
          <h3>{workItem.title}</h3>
          <p>{workItem.description}</p>
          {workItem.acceptanceCriteria.length > 0 ? (
            <ul>
              {workItem.acceptanceCriteria.map((criterion) => (
                <li key={criterion}>{criterion}</li>
              ))}
            </ul>
          ) : null}
          <small>{workItem.checksum}</small>
        </article>
      ) : null}
      <div className="definition">
        <span className="node-type">{node.type}</span>
        <h3>{node.title}</h3>
        <p>{invocations.length} invocation(s)</p>
      </div>
      {invocations.map((invocation) => (
        <article className="invocation" key={invocation.sequence}>
          <div className="invocation-header">
            <strong>Invocation {invocation.sequence}</strong>
            <span className={stateClass(displayedInvocationState(run, node, invocation))}>
              {displayedInvocationState(run, node, invocation)}
            </span>
          </div>
          <p>
            Outcome:{' '}
            {node.type === 'complete' && isTerminalRun(run)
              ? run.status
              : (invocation.outcome ?? 'pending')}
          </p>
          {invocation.attempts.map((attempt) => (
            <div className="attempt" key={attempt.number}>
              <p>
                Attempt {attempt.number} · {attempt.harnessId ?? 'native'}
                {attempt.model ? ` · ${attempt.model}` : ''} ·{' '}
                {invocation.outcome === 'failure' ? 'failed' : attempt.state}
              </p>
              {attempt.failure ? (
                <div className="invocation-failure">
                  <strong>{attempt.failure.kind.replaceAll('_', ' ')}</strong>
                  <p>{attempt.failure.message}</p>
                </div>
              ) : null}
            </div>
          ))}
          <InvocationFailureDetails invocation={invocation} />
          {activities[invocation.sequence] ? (
            <button
              className="activity-button"
              onClick={() => onOpenActivity(invocation.sequence)}
              type="button"
            >
              <span className={invocation.state === 'active' ? 'live-dot' : ''} />
              {invocation.state === 'active' ? 'Watch live activity' : 'View activity'}
            </button>
          ) : null}
          <InvocationOutputSection
            artifacts={artifacts}
            invocationSequence={invocation.sequence}
            onOpen={onOpenArtifact}
          />
        </article>
      ))}
    </div>
  );
}

function InvocationFailureDetails({
  invocation,
}: {
  readonly invocation: RunDetails['state']['invocations'][number];
}) {
  if (invocation.attempts.some(({ failure }) => failure !== undefined)) return null;
  const failure = invocationFailure(invocation);
  if (!failure) return null;
  return (
    <div className="invocation-failure">
      <strong>{failure.kind}</strong>
      <p>{failure.message}</p>
    </div>
  );
}

function EventLog({ events }: { readonly events: readonly ReplayedEvent[] }) {
  if (events.length === 0) return <p className="empty">No replayed events yet.</p>;
  return (
    <ol className="event-log">
      {events.map((event) => (
        <li key={event.id}>
          <span>{event.id}</span>
          <strong>{event.event}</strong>
          <code>{JSON.stringify(event.data)}</code>
        </li>
      ))}
    </ol>
  );
}

function entryLabel(entry: TranscriptEntry): string {
  switch (entry.kind) {
    case 'user':
      return 'User';
    case 'agent':
      return 'Agent';
    case 'reasoning':
      return 'Reasoning';
    case 'tool_call':
      return entry.toolName ? `Tool call · ${entry.toolName}` : 'Tool call';
    case 'tool_result':
      return entry.toolName ? `Tool result · ${entry.toolName}` : 'Tool result';
  }
  return 'Activity';
}

function TranscriptCard({
  entry,
  nested = false,
}: {
  readonly entry: TranscriptEntry;
  readonly nested?: boolean;
}) {
  const markdown = jsonMarkdown(entry.text);
  const shellInput = entry.kind === 'tool_call' && entry.toolName === 'shell';
  return (
    <article className={`message message-${entry.kind}${nested ? ' message-nested' : ''}`}>
      <header>
        <span className="message-role">{entryLabel(entry)}</span>
        {entry.callId ? <code className="call-id">{entry.callId}</code> : null}
        {entry.status ? <span className="tool-status">{entry.status}</span> : null}
      </header>
      <div className="message-text">
        {shellInput ? (
          <CodeViewer
            compact
            content={entry.text}
            label="command"
            language="shell"
          />
        ) : (
          <MarkdownContent content={markdown ?? entry.text} />
        )}
      </div>
    </article>
  );
}

function TranscriptViewer({
  content,
  userPrompt,
}: {
  readonly content: string;
  readonly userPrompt?: string;
}) {
  const groups = useMemo(
    () => groupTranscript(parseTranscript(content, userPrompt)),
    [content, userPrompt],
  );
  if (groups.length === 0) {
    return <CodeViewer content={content} label="transcript.ndjson" language="json" />;
  }
  return (
    <div className="transcript-viewer">
      {groups.map(({ primary, results }) => (
        <section className="transcript-group" key={primary.id}>
          <TranscriptCard entry={primary} />
          {results.length > 0 ? (
            <div className="tool-results">
              {results.map((result) => (
                <TranscriptCard entry={result} key={result.id} nested />
              ))}
            </div>
          ) : null}
        </section>
      ))}
    </div>
  );
}

function AgentOutputViewer({ content }: { readonly content: string }) {
  let parsed: Record<string, unknown> | null = null;
  try {
    const value = JSON.parse(content);
    if (isRecord(value)) parsed = value;
  } catch {
    // fall through
  }
  if (!parsed) return <CodeViewer content={content} label="agent-output.txt" language="text" />;
  const result = typeof parsed.result === 'string' ? parsed.result : null;
  const output = 'structured_output' in parsed ? parsed.structured_output : null;
  return (
    <div className="agent-output-viewer">
      {result ? (
        <div className="output-field">
          <span className="field-label">Result</span>
          <div className="field-value">
            <MarkdownContent content={result} />
          </div>
        </div>
      ) : null}
      {output !== null && output !== undefined ? (
        <details>
          <summary>Structured output</summary>
          <CodeViewer
            content={JSON.stringify(output, null, 2)}
            label="structured-output.json"
            language="json"
          />
        </details>
      ) : null}
      <details open={!result}>
        <summary>Raw JSON</summary>
        <CodeViewer content={content} label="agent-output.json" language="json" />
      </details>
    </div>
  );
}

function ArtifactContent({
  artifact,
  userPrompt,
}: {
  readonly artifact: ArtifactView;
  readonly userPrompt?: string;
}) {
  if (artifact.content === undefined) return <p className="empty">No content available.</p>;
  const json = formattedJson(artifact.content);
  switch (artifact.kind) {
    case 'harness_transcript':
      return <TranscriptViewer content={artifact.content} userPrompt={userPrompt} />;
    case 'agent_output':
      return <AgentOutputViewer content={artifact.content} />;
    case 'command_output':
      return (
        <CodeViewer
          content={json ?? artifact.content}
          label={artifact.id}
          language={json ? 'json' : 'text'}
        />
      );
    case 'git_diff':
      return <CodeViewer content={artifact.content} label={artifact.id} language="diff" />;
    case 'git_status':
      return <CodeViewer content={artifact.content} label={artifact.id} language="text" />;
    default:
      return (
        <CodeViewer
          content={json ?? artifact.content}
          label={artifact.id}
          language={json ? 'json' : 'text'}
        />
      );
  }
}

function InvocationOutputSection({
  invocationSequence,
  artifacts,
  onOpen,
}: {
  readonly invocationSequence: number;
  readonly artifacts: readonly ArtifactView[];
  readonly onOpen: (artifact: ArtifactView) => void;
}) {
  const invocationArtifacts = artifacts.filter((a) => a.invocationSequence === invocationSequence);
  if (invocationArtifacts.length === 0) return null;
  return (
    <div className="invocation-output">
      {invocationArtifacts.map((artifact) => (
        <button key={artifact.id} onClick={() => onOpen(artifact)} type="button">
          <span>{artifact.kind.replaceAll('_', ' ')}</span>
          <small>{formatByteSize(artifact.size)} · open</small>
        </button>
      ))}
    </div>
  );
}

function InspectorModal({
  title,
  metadata,
  onClose,
  contentClassName,
  children,
}: {
  readonly title: string;
  readonly metadata: string;
  readonly onClose: () => void;
  readonly contentClassName?: string;
  readonly children: ReactNode;
}) {
  useEffect(() => {
    function closeOnEscape(event: KeyboardEvent): void {
      if (event.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', closeOnEscape);
    return () => document.removeEventListener('keydown', closeOnEscape);
  }, [onClose]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) onClose();
      }}
      role="presentation"
    >
      <section aria-modal="true" className="inspector-modal" role="dialog">
        <header className="modal-header">
          <div>
            <p className="eyebrow">{metadata}</p>
            <h2>{title}</h2>
          </div>
          <button aria-label="Close" className="modal-close" onClick={onClose} type="button">
            ×
          </button>
        </header>
        <div className={`modal-content${contentClassName ? ` ${contentClassName}` : ''}`}>
          {children}
        </div>
      </section>
    </div>
  );
}

function ActivityModal({
  activity,
  busy,
  interruptible,
  onClose,
  onAction,
  steerable,
}: {
  readonly activity: InvocationActivityView;
  readonly busy: boolean;
  readonly interruptible: boolean;
  readonly onClose: () => void;
  readonly onAction: (action: 'steer' | 'interrupt', value: string) => Promise<boolean>;
  readonly steerable: boolean;
}) {
  const [message, setMessage] = useState('');
  const [actionFailed, setActionFailed] = useState(false);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const stream = streamRef.current;
    if (stream && stickToBottomRef.current) stream.scrollTop = stream.scrollHeight;
  }, [activity.transcript]);

  async function submitSteering(): Promise<void> {
    const value = message.trim();
    if (!steerable || busy || !value) return;
    setActionFailed(false);
    const completed = await onAction('steer', value);
    if (completed) setMessage('');
    else setActionFailed(true);
  }

  async function interrupt(): Promise<void> {
    if (!interruptible || busy) return;
    setActionFailed(false);
    const completed = await onAction(
      'interrupt',
      'Interrupted by the operator from the live agent session',
    );
    if (!completed) setActionFailed(true);
  }

  function handleComposerKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void submitSteering();
  }

  return (
    <InspectorModal
      contentClassName="agent-session-content"
      metadata={`${activity.harnessId} · invocation ${activity.invocationSequence} · attempt ${activity.attemptNumber}`}
      onClose={onClose}
      title={activity.complete ? 'Agent session' : 'Agent session · live'}
    >
      <div className="agent-session">
        <div
          className="agent-session-stream"
          onScroll={(event) => {
            const stream = event.currentTarget;
            stickToBottomRef.current =
              stream.scrollHeight - stream.scrollTop - stream.clientHeight < 80;
          }}
          ref={streamRef}
        >
          <TranscriptViewer content={activity.transcript} userPrompt={activity.prompt} />
        </div>
        <footer className="agent-composer">
          <div className="agent-composer-status">
            <span className={steerable ? 'connection-live' : 'connection-idle'}>
              {steerable ? 'ready for steering' : activity.complete ? 'turn complete' : 'read only'}
            </span>
            <small>Steering is durably bound to invocation {activity.invocationSequence}.</small>
          </div>
          <div className="composer-input">
            <textarea
              aria-label="Steering message"
              disabled={!steerable || busy}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={handleComposerKeyDown}
              placeholder={
                steerable
                  ? 'Add direction while the agent works…'
                  : 'This agent turn is not currently steerable.'
              }
              rows={3}
              value={message}
            />
            <div className="composer-actions">
              <button
                className="stop-button"
                disabled={!interruptible || busy}
                onClick={() => void interrupt()}
                type="button"
              >
                Stop
              </button>
              <button
                className="primary-button"
                disabled={!steerable || busy || !message.trim()}
                onClick={() => void submitSteering()}
                type="button"
              >
                Send
              </button>
            </div>
          </div>
          <div className="composer-hint">
            <small>Enter to send · Shift+Enter for a new line</small>
            {actionFailed ? <span>Control request failed. Check the run status and retry.</span> : null}
          </div>
        </footer>
      </div>
    </InspectorModal>
  );
}

function ArtifactModal({
  activity,
  artifact,
  onClose,
}: {
  readonly activity?: InvocationActivityView;
  readonly artifact: ArtifactView;
  readonly onClose: () => void;
}) {
  return (
    <InspectorModal
      metadata={[
        artifact.kind.replaceAll('_', ' '),
        artifact.invocationSequence ? `invocation ${artifact.invocationSequence}` : '',
        formatByteSize(artifact.size),
      ]
        .filter(Boolean)
        .join(' · ')}
      onClose={onClose}
      title={artifact.id}
    >
      <ArtifactContent artifact={artifact} userPrompt={activity?.prompt} />
    </InspectorModal>
  );
}

function Artifacts({
  artifacts,
  onOpen,
}: {
  readonly artifacts: readonly ArtifactView[];
  readonly onOpen: (artifact: ArtifactView) => void;
}) {
  return (
    <div className="artifact-layout">
      <div className="artifact-list">
        {artifacts.map((artifact) => (
          <button key={artifact.id} onClick={() => onOpen(artifact)} type="button">
            <strong>{artifact.kind.replaceAll('_', ' ')}</strong>
            <span>{artifact.id}</span>
            <small>
              {formatByteSize(artifact.size)}
              {artifact.invocationSequence
                ? ` · invocation ${artifact.invocationSequence}`
                : ''}
            </small>
          </button>
        ))}
      </div>
    </div>
  );
}

function ApprovalControl({
  approval,
  busy,
  delivery,
  diffArtifact,
  onDecision,
}: {
  readonly approval: ApprovalView;
  readonly busy: boolean;
  readonly delivery?: DeliveryState;
  readonly diffArtifact?: ArtifactView;
  readonly onDecision: (
    decision: 'grant' | 'reject' | 'request_changes',
    reason: string,
    metadata?: DeliveryMetadata,
  ) => void;
}) {
  const [reason, setReason] = useState('');
  const [metadata, setMetadata] = useState(delivery?.proposal?.metadata);
  const [diff, setDiff] = useState<string>();
  const [diffError, setDiffError] = useState<string>();
  const [selectedFile, setSelectedFile] = useState(0);
  useEffect(() => {
    setMetadata(delivery?.proposal?.metadata);
  }, [delivery?.proposal?.checksum]);
  useEffect(() => {
    setDiff(undefined);
    setDiffError(undefined);
    setSelectedFile(0);
    if (!diffArtifact) {
      setDiff('');
      return;
    }
    void fetchArtifact(approval.runId, diffArtifact.id)
      .then((artifact) => setDiff(artifact.content ?? ''))
      .catch((cause: unknown) =>
        setDiffError(cause instanceof Error ? cause.message : 'The bound diff could not be read'),
      );
  }, [approval.runId, diffArtifact?.id]);
  const files = (diff ?? '')
    .split(/(?=^diff --git )/m)
    .filter((section) => section.startsWith('diff --git '));
  const activeDiff = files[selectedFile] ?? diff ?? '';
  const activeFile =
    files[selectedFile]?.match(/^diff --git a\/(.+?) b\//m)?.[1] ?? 'complete.diff';
  const deliveryReview = approval.binding.preparedTree !== undefined && metadata !== undefined;
  return (
    <article className="approval-card">
      <header className="approval-summary">
        <div>
          <span className="node-type">Review required</span>
          <h3>{approval.binding.resolvedAction}</h3>
          <p>
            {approval.nodeId} · invocation {approval.invocationSequence}
          </p>
        </div>
        <span className={stateClass(approval.state)}>{approval.state}</span>
      </header>
      <details className="approval-binding">
        <summary>Approval binding</summary>
        <dl>
          <dt>Repository HEAD</dt>
          <dd>{approval.binding.repositoryHead}</dd>
          <dt>Bound artifacts</dt>
          <dd>{approval.binding.artifactChecksums.length}</dd>
          {approval.binding.preparedTree ? (
            <>
              <dt>Prepared tree</dt>
              <dd>{approval.binding.preparedTree}</dd>
            </>
          ) : null}
        </dl>
      </details>
      {deliveryReview && metadata ? (
        <div className="delivery-review">
          <section className="diff-review">
            <header>
              <div>
                <h4>Changed files</h4>
                <span>{files.length} files in the bound tree</span>
              </div>
            </header>
            <div className="diff-workspace">
              {files.length > 0 ? (
                <nav aria-label="Changed files" className="changed-files">
                  {files.map((file, index) => {
                    const filename =
                      file.match(/^diff --git a\/(.+?) b\//m)?.[1] ?? `Change ${index + 1}`;
                    return (
                      <button
                        aria-pressed={selectedFile === index}
                        className={selectedFile === index ? 'active' : ''}
                        key={file.slice(0, 80)}
                        onClick={() => setSelectedFile(index)}
                        title={filename}
                        type="button"
                      >
                        {filename}
                      </button>
                    );
                  })}
                </nav>
              ) : null}
              <div className="diff-editor">
                {diffError ? <p className="diff-error">{diffError}</p> : null}
                {!diffError && diff === undefined ? (
                  <p className="empty">Loading the bound diff…</p>
                ) : null}
                {!diffError && diff !== undefined ? (
                  <CodeViewer
                    content={activeDiff || 'The bound diff is empty.'}
                    label={activeFile}
                    language="diff"
                  />
                ) : null}
              </div>
            </div>
          </section>
          <section className="proposal-form">
            <header>
              <h4>Delivery metadata</h4>
              <span>{delivery?.repairsUsed ?? 0} of 2 repair returns used</span>
            </header>
            <label>
              Commit title
              <input
                value={metadata.commitTitle}
                onChange={(event) =>
                  setMetadata({ ...metadata, commitTitle: event.target.value })
                }
              />
            </label>
            <label>
              Commit body
              <textarea
                value={metadata.commitBody ?? ''}
                onChange={(event) =>
                  setMetadata({ ...metadata, commitBody: event.target.value })
                }
              />
            </label>
            <label>
              Pull request title
              <input
                value={metadata.pullRequestTitle}
                onChange={(event) =>
                  setMetadata({ ...metadata, pullRequestTitle: event.target.value })
                }
              />
            </label>
            <label>
              Pull request body
              <textarea
                value={metadata.pullRequestBody ?? ''}
                onChange={(event) =>
                  setMetadata({ ...metadata, pullRequestBody: event.target.value })
                }
              />
            </label>
            <label className="checkbox-label">
              <input
                checked={metadata.draft}
                onChange={(event) => setMetadata({ ...metadata, draft: event.target.checked })}
                type="checkbox"
              />
              Open as draft pull request
            </label>
          </section>
        </div>
      ) : null}
      {approval.state === 'waiting_for_approval' ? (
        <footer className="approval-decision">
          <label>
            Review note
            <textarea
              placeholder="Explain why this tree is ready, or what needs to change."
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className="approval-actions">
            <button
              className="reject"
              disabled={busy || !reason.trim()}
              onClick={() => onDecision('reject', reason, metadata)}
              type="button"
            >
              Fail
            </button>
            {deliveryReview && (delivery?.repairsUsed ?? 0) < 2 ? (
              <button
                disabled={busy || !reason.trim()}
                onClick={() => onDecision('request_changes', reason, metadata)}
                type="button"
              >
                Request changes
              </button>
            ) : null}
            <button
              className="approve"
              disabled={busy || !reason.trim()}
              onClick={() => onDecision('grant', reason, metadata)}
              type="button"
            >
              Approve
            </button>
          </div>
        </footer>
      ) : (
        <span className={stateClass(approval.state)}>{approval.state}</span>
      )}
    </article>
  );
}

const autoRefreshEvents = new Set([
  'run.cancelled',
  'invocation.activated',
  'attempt.started',
  'attempt.resumed',
  'attempt.resume_token_recorded',
  'attempt.artifact_published',
  'attempt.failed',
  'attempt.interrupt_requested',
  'attempt.interrupted',
  'agent.steering_requested',
  'agent.steering_applied',
  'agent.steering_rejected',
  'invocation.retry_requested',
  'invocation.skipped',
  'invocation.completed',
  'run.completed',
  'run.paused',
  'run.resumed',
  'approval.requested',
  'approval.granted',
  'approval.rejected',
  'approval.changes_requested',
  'delivery.proposed',
  'delivery.metadata_updated',
  'delivery.committed',
  'delivery.publication_started',
  'delivery.publication_succeeded',
  'delivery.publication_failed',
]);

function storedDiagramMode(): DiagramMode {
  try {
    return localStorage.getItem('kouro:diagram-mode') === 'graph' ? 'graph' : 'flowchart';
  } catch {
    return 'flowchart';
  }
}

function storedDiagramDirection(): DiagramDirection {
  try {
    return localStorage.getItem('kouro:diagram-direction') === 'LR' ? 'LR' : 'TB';
  } catch {
    return 'TB';
  }
}

function storeDiagramPreference(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Device-local preferences are optional when browser storage is unavailable.
  }
}

function maximumInspectorHeight(): number {
  return typeof window === 'undefined' ? 720 : Math.max(240, window.innerHeight - 340);
}

function constrainedInspectorHeight(value: number): number {
  return Math.min(maximumInspectorHeight(), Math.max(240, value));
}

function storedInspectorHeight(): number {
  try {
    const stored = Number(localStorage.getItem('kouro:inspector-height'));
    return Number.isFinite(stored) && stored > 0
      ? constrainedInspectorHeight(stored)
      : constrainedInspectorHeight(380);
  } catch {
    return constrainedInspectorHeight(380);
  }
}

function workspaceStyle(inspectorHeight: number): WorkspaceStyle {
  return { '--inspector-height': `${inspectorHeight}px` };
}

function ExecutionConsole() {
  const [runs, setRuns] = useState<readonly RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [run, setRun] = useState<RunDetails>();
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('details');
  const [events, setEvents] = useState<readonly ReplayedEvent[]>([]);
  const [artifacts, setArtifacts] = useState<readonly ArtifactView[]>([]);
  const [activeArtifact, setActiveArtifact] = useState<ArtifactView | null>(null);
  const [activities, setActivities] = useState<
    Readonly<Record<number, InvocationActivityView>>
  >({});
  const [activeActivitySequence, setActiveActivitySequence] = useState<number | null>(null);
  const [approvals, setApprovals] = useState<readonly ApprovalView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [diagramMode, setDiagramMode] = useState<DiagramMode>(storedDiagramMode);
  const [diagramDirection, setDiagramDirection] =
    useState<DiagramDirection>(storedDiagramDirection);
  const [inspectorHeight, setInspectorHeight] = useState(storedInspectorHeight);
  const drawerDragRef = useRef<DrawerDrag | undefined>(undefined);

  useEffect(() => {
    fetchRuns()
      .then((next) => {
        setRuns(next);
        setSelectedRunId((current) => current ?? next[0]?.id);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Load failed'));
  }, []);

  const refreshTimerRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!selectedRunId) return undefined;
    setEvents([]);
    setActiveArtifact(null);
    setActivities({});
    setActiveActivitySequence(null);
    Promise.all([
      fetchRun(selectedRunId),
      fetchArtifacts(selectedRunId),
      fetchApprovals(selectedRunId),
    ])
      .then(([nextRun, nextArtifacts, nextApprovals]) => {
        setRun(nextRun);
        setArtifacts(nextArtifacts);
        setApprovals(nextApprovals);
        setSelectedNode(nextRun.nodes[0]?.id ?? null);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Load failed'));
    const runId = selectedRunId;
    const closeEvents = reconnectEvents(runId, 0, (event) => {
      setEvents((current) =>
        current.some(({ id }) => id === event.id) ? current : [...current, event],
      );
      if (!autoRefreshEvents.has(event.event)) return;
      if (refreshTimerRef.current !== undefined) window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = window.setTimeout(() => {
        Promise.all([
          fetchRun(runId),
          fetchArtifacts(runId),
          fetchApprovals(runId),
          fetchRuns(),
        ])
          .then(([nextRun, nextArtifacts, nextApprovals, nextRuns]) => {
            setRun(nextRun);
            setArtifacts(nextArtifacts);
            setApprovals(nextApprovals);
            setRuns(nextRuns);
          })
          .catch(() => {});
      }, 100);
    });
    return () => {
      closeEvents();
      if (refreshTimerRef.current !== undefined) window.clearTimeout(refreshTimerRef.current);
    };
  }, [selectedRunId]);

  useEffect(() => {
    if (!run) return undefined;
    const sequences = run.state.invocations
      .filter(
        ({ state, attempts }) =>
          state === 'active' && attempts.some((attempt) => attempt.state === 'running'),
      )
      .map(({ sequence }) => sequence);
    if (sequences.length === 0) return undefined;
    async function refreshActivities(): Promise<void> {
      if (!run) return;
      try {
        const observed = await Promise.all(
          sequences.map(async (sequence) => ({
            sequence,
            activity: await fetchInvocationActivity(run.id, sequence),
          })),
        );
        setActivities((current) => {
          const next = { ...current };
          for (const { sequence, activity } of observed) {
            if (activity) next[sequence] = activity;
          }
          return next;
        });
      } catch {
        // The durable run stream remains usable if best-effort activity is unavailable.
      }
    }
    void refreshActivities();
    const timer = window.setInterval(() => void refreshActivities(), 750);
    return () => window.clearInterval(timer);
  }, [run]);

  const nodes = useMemo(
    () =>
      run
        ? diagramMode === 'graph'
          ? networkGraphNodes(run)
          : flowchartNodes(run, diagramDirection)
        : [],
    [diagramDirection, diagramMode, run],
  );
  const edges = useMemo(
    () => (run ? graphEdges(run, diagramMode, diagramDirection) : []),
    [diagramDirection, diagramMode, run],
  );
  const node = run?.nodes.find(({ id }) => id === selectedNode) ?? null;
  const activeActivity =
    activeActivitySequence === null ? undefined : activities[activeActivitySequence];

  async function refreshExecution(runId: string): Promise<void> {
    const [nextRun, nextArtifacts, nextApprovals, nextRuns] = await Promise.all([
      fetchRun(runId),
      fetchArtifacts(runId),
      fetchApprovals(runId),
      fetchRuns(),
    ]);
    setRun(nextRun);
    setArtifacts(nextArtifacts);
    setApprovals(nextApprovals);
    setRuns(nextRuns);
  }

  async function submitRunAction(
    action: 'pause' | 'resume' | 'cancel',
    reason?: string,
  ): Promise<void> {
    if (!run) return;
    setBusy(true);
    setError(undefined);
    try {
      await controlRun(run.id, action, {
        actor: 'web-user',
        ...(reason ? { reason } : {}),
        idempotencyKey: newIdempotencyKey(),
      });
      await refreshExecution(run.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Run could not be ${action}d`);
    } finally {
      setBusy(false);
    }
  }

  async function submitInvocationAction(
    invocationSequence: number,
    action: InvocationAction,
    value: string,
  ): Promise<boolean> {
    if (!run) return false;
    setBusy(true);
    setError(undefined);
    try {
      await controlInvocation(
        run.id,
        invocationSequence,
        action,
        action === 'steer'
          ? {
              actor: 'web-user',
              message: value,
              idempotencyKey: newIdempotencyKey(),
            }
          : {
              actor: 'web-user',
              reason: value,
              idempotencyKey: newIdempotencyKey(),
            },
      );
      await refreshExecution(run.id);
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : `Invocation could not be ${action}ed`);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function openArtifact(artifact: ArtifactView): Promise<void> {
    if (!run) return;
    try {
      const [loadedArtifact, activity] = await Promise.all([
        fetchArtifact(run.id, artifact.id),
        artifact.invocationSequence === undefined
          ? Promise.resolve(undefined)
          : fetchInvocationActivity(run.id, artifact.invocationSequence),
      ]);
      if (activity) {
        setActivities((current) => ({
          ...current,
          [activity.invocationSequence]: activity,
        }));
      }
      setActiveArtifact(loadedArtifact);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Artifact load failed');
    }
  }

  async function openActivity(invocationSequence: number): Promise<void> {
    if (!run) return;
    setActiveActivitySequence(invocationSequence);
    try {
      const activity = await fetchInvocationActivity(run.id, invocationSequence);
      if (activity) {
        setActivities((current) => ({ ...current, [invocationSequence]: activity }));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Activity load failed');
    }
  }

  async function submitDecision(
    approval: ApprovalView,
    decision: 'grant' | 'reject' | 'request_changes',
    reason: string,
    metadata?: DeliveryMetadata,
  ): Promise<void> {
    if (!run) return;
    setBusy(true);
    try {
      await decideApproval(run.id, approval.invocationSequence, {
        decision,
        actor: 'web-user',
        reason,
        idempotencyKey: newIdempotencyKey(),
        binding: approval.binding,
        expectedEventSequence: approval.expectedEventSequence,
        ...(metadata ? { metadata } : {}),
      });
      const [nextRun, nextApprovals, nextRuns] = await Promise.all([
        fetchRun(run.id),
        fetchApprovals(run.id),
        fetchRuns(),
      ]);
      setRun(nextRun);
      setApprovals(nextApprovals);
      setRuns(nextRuns);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Approval failed');
    } finally {
      setBusy(false);
    }
  }

  async function removeSelectedRun(): Promise<void> {
    if (!run || !isTerminalRun(run)) return;
    const confirmed = window.confirm(
      `Permanently delete ${run.id} and its Kouro-owned worktree, artifacts, and history?`,
    );
    if (!confirmed) return;
    setBusy(true);
    try {
      await deleteRun(run.id);
      const nextRuns = await fetchRuns();
      setRuns(nextRuns);
      setRun(undefined);
      setEvents([]);
      setArtifacts([]);
      setApprovals([]);
      setActiveArtifact(null);
      setActivities({});
      setActiveActivitySequence(null);
      setSelectedNode(null);
      setSelectedRunId(nextRuns[0]?.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Run deletion failed');
    } finally {
      setBusy(false);
    }
  }

  function setAndStoreInspectorHeight(value: number): void {
    const next = constrainedInspectorHeight(value);
    setInspectorHeight(next);
    storeDiagramPreference('kouro:inspector-height', String(next));
  }

  function startDrawerResize(event: ReactPointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    drawerDragRef.current = {
      pointerId: event.pointerId,
      startHeight: inspectorHeight,
      startY: event.clientY,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function resizeDrawer(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = drawerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    setInspectorHeight(constrainedInspectorHeight(drag.startHeight + drag.startY - event.clientY));
  }

  function finishDrawerResize(event: ReactPointerEvent<HTMLDivElement>): void {
    const drag = drawerDragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const next = constrainedInspectorHeight(drag.startHeight + drag.startY - event.clientY);
    drawerDragRef.current = undefined;
    setInspectorHeight(next);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    storeDiagramPreference('kouro:inspector-height', String(next));
  }

  function cancelDrawerResize(event: ReactPointerEvent<HTMLDivElement>): void {
    if (drawerDragRef.current?.pointerId !== event.pointerId) return;
    drawerDragRef.current = undefined;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    storeDiagramPreference('kouro:inspector-height', String(inspectorHeight));
  }

  function resizeDrawerWithKeyboard(event: ReactKeyboardEvent<HTMLDivElement>): void {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') {
      setAndStoreInspectorHeight(240);
      return;
    }
    if (event.key === 'End') {
      setAndStoreInspectorHeight(maximumInspectorHeight());
      return;
    }
    setAndStoreInspectorHeight(inspectorHeight + (event.key === 'ArrowUp' ? 40 : -40));
  }

  return (
    <div className="execution-layout">
      <RunList runs={runs} selected={selectedRunId} onSelect={setSelectedRunId} />
      <section className="workspace" style={workspaceStyle(inspectorHeight)}>
        {error ? <div className="error-banner">{error}</div> : null}
        {run ? (
          <>
            <header className="run-header">
              <div>
                <p className="eyebrow">{run.workflowId}</p>
                <h2>{run.id}</h2>
                <small className="repository-path">{run.repositoryPath}</small>
              </div>
              <div className="run-header-actions">
                <div aria-label="Run controls" className="run-controls" role="group">
                  {run.status === 'paused' ? (
                    <button
                      className="primary-button"
                      disabled={busy}
                      onClick={() => void submitRunAction('resume')}
                      type="button"
                    >
                      Resume
                    </button>
                  ) : (
                    <button
                      disabled={
                        busy ||
                        !['running', 'waiting_for_approval'].includes(run.status)
                      }
                      onClick={() => void submitRunAction('pause')}
                      type="button"
                    >
                      Pause
                    </button>
                  )}
                  {!isTerminalRun(run) ? (
                    <button
                      className="danger-button"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Cancel ${run.id}? The durable history and worktree will be retained.`,
                          )
                        ) {
                          void submitRunAction('cancel', 'Cancelled from the web workspace');
                        }
                      }}
                      type="button"
                    >
                      Cancel
                    </button>
                  ) : null}
                </div>
                <div className="run-stat">
                  <span className={stateClass(run.status)}>{run.status}</span>
                  <small>{run.eventCount} durable events</small>
                </div>
                {isTerminalRun(run) ? (
                  <button
                    className="danger-button"
                    disabled={busy}
                    onClick={() => void removeSelectedRun()}
                    type="button"
                  >
                    Delete run
                  </button>
                ) : null}
              </div>
            </header>
            <section className="graph">
              <div className="graph-toolbar">
                <div aria-label="Diagram style" className="segmented-control" role="group">
                  {(['flowchart', 'graph'] as const).map((mode) => (
                    <button
                      aria-pressed={diagramMode === mode}
                      className={diagramMode === mode ? 'active' : ''}
                      key={mode}
                      onClick={() => {
                        setDiagramMode(mode);
                        storeDiagramPreference('kouro:diagram-mode', mode);
                      }}
                      type="button"
                    >
                      {mode}
                    </button>
                  ))}
                </div>
                <div aria-label="Flow direction" className="segmented-control" role="group">
                  {(['TB', 'LR'] as const).map((direction) => (
                    <button
                      aria-pressed={diagramDirection === direction}
                      className={diagramDirection === direction ? 'active' : ''}
                      disabled={diagramMode === 'graph'}
                      key={direction}
                      onClick={() => {
                        setDiagramDirection(direction);
                        storeDiagramPreference('kouro:diagram-direction', direction);
                      }}
                      title={direction === 'TB' ? 'Top to bottom' : 'Left to right'}
                      type="button"
                    >
                      {direction}
                    </button>
                  ))}
                </div>
              </div>
              <ReactFlow
                edges={edges}
                edgeTypes={workflowEdgeTypes}
                fitView
                fitViewOptions={{ padding: 0.24 }}
                key={`${run.id}:${diagramMode}:${diagramDirection}`}
                nodes={nodes}
                nodeTypes={workflowNodeTypes}
                nodesConnectable={false}
                nodesDraggable={false}
                onNodeClick={(_, selected) => {
                  setSelectedNode(selected.id);
                  setTab('details');
                }}
              >
                <Background color="#30363d" gap={24} />
                <MiniMap nodeColor="#388bfd" pannable zoomable />
                <Controls showInteractive={false} />
              </ReactFlow>
            </section>
            <section className="inspector">
              <div
                aria-label="Resize bottom drawer"
                aria-orientation="horizontal"
                aria-valuemax={maximumInspectorHeight()}
                aria-valuemin={240}
                aria-valuenow={inspectorHeight}
                className="drawer-resize-handle"
                onKeyDown={resizeDrawerWithKeyboard}
                onPointerCancel={cancelDrawerResize}
                onPointerDown={startDrawerResize}
                onPointerMove={resizeDrawer}
                onPointerUp={finishDrawerResize}
                role="separator"
                tabIndex={0}
                title="Drag to resize the bottom drawer"
              >
                <span />
              </div>
              <nav className="tabs">
                {(['control', 'details', 'events', 'artifacts', 'approval'] as const).map((name) => (
                  <button
                    className={tab === name ? 'active' : ''}
                    key={name}
                    onClick={() => setTab(name)}
                    type="button"
                  >
                    {name}
                    {name === 'approval' && approvals.length > 0 ? (
                      <span>{approvals.length}</span>
                    ) : null}
                  </button>
                ))}
              </nav>
              <div className="panel">
                {tab === 'control' ? (
                  <OperatorConsole
                    activities={activities}
                    busy={busy}
                    onAction={submitInvocationAction}
                    onOpenActivity={(sequence) => void openActivity(sequence)}
                    run={run}
                    selectedNodeId={selectedNode}
                  />
                ) : null}
                {tab === 'details' ? (
                  <NodeDetails
                    activities={activities}
                    artifacts={artifacts}
                    node={node}
                    onOpenActivity={(sequence) => void openActivity(sequence)}
                    onOpenArtifact={(artifact) => void openArtifact(artifact)}
                    run={run}
                  />
                ) : null}
                {tab === 'events' ? <EventLog events={events} /> : null}
                {tab === 'artifacts' ? (
                  <Artifacts
                    artifacts={artifacts}
                    onOpen={(artifact) => void openArtifact(artifact)}
                  />
                ) : null}
                {tab === 'approval' ? (
                  approvals.length > 0 ? (
                    approvals.map((approval) => (
                      <ApprovalControl
                        approval={approval}
                        busy={busy}
                        delivery={run.state.delivery}
                        diffArtifact={approvalDiffArtifact(
                          artifacts,
                          approval.invocationSequence,
                        )}
                        key={approval.invocationSequence}
                        onDecision={(decision, reason, metadata) =>
                          void submitDecision(approval, decision, reason, metadata)
                        }
                      />
                    ))
                  ) : (
                    <p className="empty">This run has no approval records.</p>
                  )
                ) : null}
                {run.state.delivery?.commit &&
                run.state.delivery.publication.status !== 'published' ? (
                  <button
                    disabled={busy}
                    onClick={() => {
                      setBusy(true);
                      void publishRun(run.id)
                        .then(() => fetchRun(run.id))
                        .then(setRun)
                        .catch((cause: unknown) =>
                          setError(
                            cause instanceof Error ? cause.message : 'Publication failed',
                          ),
                        )
                        .finally(() => setBusy(false));
                    }}
                    type="button"
                  >
                    Publish PR
                  </button>
                ) : null}
                {run.state.delivery?.publication.status === 'published' ? (
                  <a
                    href={run.state.delivery.publication.url}
                    rel="noreferrer"
                    target="_blank"
                  >
                    PR #{run.state.delivery.publication.number}
                  </a>
                ) : null}
              </div>
            </section>
            <footer className="ide-status-bar">
              <span>Kouro workspace</span>
              <span>{repositoryName(run.repositoryPath)}</span>
              <span>{run.workflowVersion}</span>
              <span>{run.workflowChecksum.slice(0, 19)}…</span>
              <span className="status-spacer" />
              <span>{run.invocationCount} invocations</span>
              <span>{run.pendingApprovalCount} approvals</span>
            </footer>
          </>
        ) : (
          <div className="loading">Waiting for durable run state…</div>
        )}
      </section>
      {activeArtifact ? (
        <ArtifactModal
          activity={
            activeArtifact.invocationSequence === undefined
              ? undefined
              : activities[activeArtifact.invocationSequence]
          }
          artifact={activeArtifact}
          onClose={() => setActiveArtifact(null)}
        />
      ) : null}
      {activeActivity ? (
        <ActivityModal
          activity={activeActivity}
          busy={busy}
          interruptible={
            run
              ? invocationControlAvailability(run, activeActivity.invocationSequence).interruptible
              : false
          }
          onAction={(action, value) =>
            submitInvocationAction(activeActivity.invocationSequence, action, value)
          }
          onClose={() => setActiveActivitySequence(null)}
          steerable={
            run
              ? invocationControlAvailability(run, activeActivity.invocationSequence).steerable
              : false
          }
        />
      ) : null}
    </div>
  );
}

const boardColumns = [
  'backlog',
  'ready',
  'planning',
  'waiting_for_plan_approval',
  'implementing',
  'validating',
  'repairing',
  'reviewing',
  'waiting_for_delivery_approval',
  'blocked',
  'failed',
  'done',
  'cancelled',
] as const;

function TicketHistory({ details }: { readonly details: TicketDetails }) {
  return (
    <div className="ticket-history">
      <section>
        <h4>Runs</h4>
        {details.runs.length === 0 ? <p className="empty">No linked runs.</p> : null}
        {details.runs.map((run) => (
          <article key={run.runId}>
            <strong>{run.runId}</strong>
            <span>{run.kind}</span>
            <span className={stateClass(run.execution?.column ?? 'unavailable')}>
              {run.execution?.column ?? 'unavailable'}
            </span>
            <time>{run.createdAt}</time>
          </article>
        ))}
      </section>
      <section>
        <h4>Snapshots</h4>
        {details.snapshots.length === 0 ? <p className="empty">No captured snapshots.</p> : null}
        {details.snapshots.map((snapshot) => (
          <article key={snapshot.id}>
            <strong>Revision {snapshot.providerRevision}</strong>
            <span>{snapshot.provider}</span>
            <span>{snapshot.runId}</span>
            <time>{snapshot.capturedAt}</time>
          </article>
        ))}
      </section>
      <section>
        <h4>Synchronization</h4>
        <article>
          <strong>{details.syncState.provider}</strong>
          <span className={stateClass(details.syncState.status)}>{details.syncState.status}</span>
          <span>{details.syncState.lastError ?? 'No synchronization error'}</span>
          <time>{details.syncState.lastSyncedAt ?? 'Never synchronized'}</time>
        </article>
        {details.syncOperations.map((operation) => (
          <article key={operation.idempotencyKey}>
            <strong>{operation.operation}</strong>
            <span>{operation.provider}</span>
            <span className={stateClass(operation.status)}>{operation.status}</span>
            <time>{operation.updatedAt}</time>
          </article>
        ))}
      </section>
      <section>
        <h4>Migration</h4>
        {details.migrations.length === 0 ? <p className="empty">No migration history.</p> : null}
        {details.migrations.map((migration) => (
          <article key={`${migration.ticketId}:${migration.stage}`}>
            <strong>{migration.stage.replaceAll('_', ' ')}</strong>
            <span>{migration.targetProvider}</span>
            <span>{migration.lastError ?? 'Checkpoint durable'}</span>
            <time>{migration.updatedAt}</time>
          </article>
        ))}
      </section>
    </div>
  );
}

function TicketInspector({ details }: { readonly details: TicketDetails }) {
  const { ticket } = details;
  return (
    <aside className="ticket-inspector">
      <header>
        <div>
          <p className="eyebrow">
            {ticket.binding.kind} · revision {ticket.revision}
          </p>
          <h2>{ticket.title}</h2>
        </div>
        <span className={stateClass(details.column)}>{details.column.replaceAll('_', ' ')}</span>
      </header>
      <p className="ticket-description">{ticket.description || 'No description provided.'}</p>
      <dl className="ticket-metadata">
        <dt>Priority</dt>
        <dd>{ticket.priority ?? 'none'}</dd>
        <dt>Labels</dt>
        <dd>{ticket.labels.join(', ') || 'none'}</dd>
        <dt>Assignees</dt>
        <dd>{ticket.assignees.join(', ') || 'none'}</dd>
        <dt>Updated</dt>
        <dd>{ticket.updatedAt}</dd>
      </dl>
      <TicketHistory details={details} />
    </aside>
  );
}

function ProviderConfigurations({
  configurations,
}: {
  readonly configurations: readonly TicketProviderConfigurationView[];
}) {
  return (
    <section className="provider-configurations">
      <div>
        <p className="eyebrow">Provider configuration</p>
        <h3>Ticket authorities</h3>
      </div>
      <p className="provider-note">
        Credentials stay in server composition and are never returned to the browser.
      </p>
      {configurations.map((configuration) => (
        <article key={configuration.id}>
          <div>
            <strong>{configuration.displayName}</strong>
            <span className={stateClass(configuration.configured ? 'succeeded' : 'pending')}>
              {configuration.configured ? 'configured' : 'not configured'}
            </span>
          </div>
          <p>{configuration.message}</p>
          {configuration.endpoint ? <small>{configuration.endpoint}</small> : null}
          {configuration.owner && configuration.repository ? (
            <small>
              {configuration.owner}/{configuration.repository}
            </small>
          ) : null}
          <small>Credentials: {configuration.credentialSource.replaceAll('_', ' ')}</small>
        </article>
      ))}
    </section>
  );
}

function TicketBoard({
  tickets,
  selectedTicketId,
  onSelect,
}: {
  readonly tickets: readonly TicketListItem[];
  readonly selectedTicketId?: string;
  readonly onSelect: (ticketId: string) => void;
}) {
  return (
    <div className="ticket-board">
      {boardColumns.map((column) => {
        const cards = tickets.filter((ticket) => ticket.column === column);
        return (
          <section className="ticket-column" key={column}>
            <header>
              <strong>{column.replaceAll('_', ' ')}</strong>
              <span className="count">{cards.length}</span>
            </header>
            {cards.map(({ ticket, activeRun }) => (
              <button
                className={ticket.id === selectedTicketId ? 'ticket-card selected' : 'ticket-card'}
                key={ticket.id}
                onClick={() => onSelect(ticket.id)}
                type="button"
              >
                <small>{ticket.id}</small>
                <strong>{ticket.title}</strong>
                <span>{ticket.priority ?? 'no priority'}</span>
                {activeRun ? <span>{activeRun.runId}</span> : null}
              </button>
            ))}
          </section>
        );
      })}
    </div>
  );
}

function TicketConsole() {
  const [projects, setProjects] = useState<readonly TicketProjectView[]>([]);
  const [projectId, setProjectId] = useState<string>();
  const [tickets, setTickets] = useState<readonly TicketListItem[]>([]);
  const [selectedTicketId, setSelectedTicketId] = useState<string>();
  const [details, setDetails] = useState<TicketDetails>();
  const [providers, setProviders] = useState<readonly TicketProviderConfigurationView[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    Promise.all([fetchTicketProjects(), fetchTicketProviderConfigurations()])
      .then(([nextProjects, nextProviders]) => {
        setProjects(nextProjects);
        setProviders(nextProviders);
        setProjectId((current) => current ?? nextProjects[0]?.id);
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : 'Ticket configuration load failed'),
      );
  }, []);

  useEffect(() => {
    if (!projectId) {
      setTickets([]);
      setSelectedTicketId(undefined);
      return;
    }
    fetchTickets(projectId)
      .then((nextTickets) => {
        setTickets(nextTickets);
        setSelectedTicketId((current) =>
          nextTickets.some(({ ticket }) => ticket.id === current)
            ? current
            : nextTickets[0]?.ticket.id,
        );
      })
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : 'Ticket load failed'),
      );
  }, [projectId]);

  useEffect(() => {
    if (!selectedTicketId) {
      setDetails(undefined);
      return;
    }
    fetchTicket(selectedTicketId)
      .then(setDetails)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : 'Ticket detail load failed'),
      );
  }, [selectedTicketId]);

  return (
    <div className="ticket-console">
      {error ? <div className="error-banner">{error}</div> : null}
      <header className="ticket-console-header">
        <div>
          <p className="eyebrow">Planning and execution</p>
          <h1>Ticket board</h1>
        </div>
        <label>
          Project
          <select value={projectId ?? ''} onChange={(event) => setProjectId(event.target.value)}>
            {projects.length === 0 ? <option value="">No ticket projects</option> : null}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.id} · {project.ticketCount}
              </option>
            ))}
          </select>
        </label>
      </header>
      <TicketBoard
        tickets={tickets}
        selectedTicketId={selectedTicketId}
        onSelect={setSelectedTicketId}
      />
      <div className="ticket-lower">
        {details ? (
          <TicketInspector details={details} />
        ) : (
          <div className="ticket-empty">Select a ticket to inspect its durable history.</div>
        )}
        <ProviderConfigurations configurations={providers} />
      </div>
    </div>
  );
}

export function App() {
  const [surface, setSurface] = useState<'tickets' | 'runs'>('tickets');
  return (
    <main className="app-shell">
      <header className="surface-nav">
        <div className="product-mark" aria-hidden="true">
          K
        </div>
        <div className="product-name">
          <strong>Kouro</strong>
          <span>Developer workflows</span>
        </div>
        <nav aria-label="Primary">
          <button
            aria-current={surface === 'tickets' ? 'page' : undefined}
            className={surface === 'tickets' ? 'active' : ''}
            onClick={() => setSurface('tickets')}
            type="button"
          >
            Tickets
          </button>
          <button
            aria-current={surface === 'runs' ? 'page' : undefined}
            className={surface === 'runs' ? 'active' : ''}
            onClick={() => setSurface('runs')}
            type="button"
          >
            Actions
          </button>
        </nav>
        <span className="environment-badge">
          <span aria-hidden="true" />
          Local
        </span>
      </header>
      {surface === 'tickets' ? <TicketConsole /> : <ExecutionConsole />}
    </main>
  );
}
