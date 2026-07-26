import '@xyflow/react/dist/style.css';

import type {
  ApprovalView,
  ArtifactView,
  RunDetails,
  RunSummary,
  WorkflowNodeView,
} from '@kairo/api-contracts';
import {
  Background,
  Controls,
  type Edge,
  MiniMap,
  type Node,
  ReactFlow,
} from '@xyflow/react';
import { useEffect, useMemo, useState } from 'react';

import {
  decideApproval,
  fetchApprovals,
  fetchArtifact,
  fetchArtifacts,
  fetchRun,
  fetchRuns,
  reconnectEvents,
  type ReplayedEvent,
} from './api.ts';

type Tab = 'details' | 'events' | 'artifacts' | 'approval';

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

function graphNodes(run: RunDetails): Node[] {
  return run.nodes.map((node, index) => ({
    id: node.id,
    position: {
      x: (index % 4) * 230,
      y: Math.floor(index / 4) * 140,
    },
    data: {
      label: (
        <div className="graph-node">
          <small>{node.type}</small>
          <strong>{node.title}</strong>
          <span className={stateClass(node.latestState ?? 'pending')}>
            {node.latestState ?? 'not started'}
          </span>
        </div>
      ),
    },
    style: {
      borderColor: node.latestState === 'failed' ? '#e86f51' : '#273a57',
      background: '#101a2b',
      color: '#eef5ff',
      width: 190,
    },
  }));
}

function graphEdges(run: RunDetails): Edge[] {
  return run.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.outcome,
    animated: true,
    style: { stroke: '#5f789d' },
    labelStyle: { fill: '#9fb1cb', fontSize: 11 },
  }));
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
        <p className="eyebrow">Execution console</p>
        <h1>Kairo</h1>
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
            <span className="run-meta">{run.workflowId}</span>
            <span className={stateClass(run.status)}>{run.status}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}

function NodeDetails({
  node,
  run,
}: {
  readonly node: WorkflowNodeView | null;
  readonly run: RunDetails;
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
          <div>
            <strong>Invocation {invocation.sequence}</strong>
            <span className={stateClass(invocation.state)}>{invocation.state}</span>
          </div>
          <p>Outcome: {invocation.outcome ?? 'pending'}</p>
          {invocation.attempts.map((attempt) => (
            <p key={attempt.number}>
              Attempt {attempt.number} · {attempt.harnessId ?? 'native'}
              {attempt.model ? ` · ${attempt.model}` : ''} · {attempt.state}
            </p>
          ))}
        </article>
      ))}
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

function Artifacts({
  artifacts,
  active,
  onOpen,
}: {
  readonly artifacts: readonly ArtifactView[];
  readonly active: ArtifactView | null;
  readonly onOpen: (artifact: ArtifactView) => void;
}) {
  return (
    <div className="artifact-layout">
      <div className="artifact-list">
        {artifacts.map((artifact) => (
          <button key={artifact.id} onClick={() => onOpen(artifact)} type="button">
            <strong>{artifact.kind.replaceAll('_', ' ')}</strong>
            <span>{artifact.id}</span>
            <small>{artifact.size} bytes</small>
          </button>
        ))}
      </div>
      <pre className={active?.kind === 'git_diff' ? 'artifact-content diff' : 'artifact-content'}>
        {active?.content ?? 'Select an artifact to inspect its content.'}
      </pre>
    </div>
  );
}

function ApprovalControl({
  approval,
  busy,
  onDecision,
}: {
  readonly approval: ApprovalView;
  readonly busy: boolean;
  readonly onDecision: (decision: 'grant' | 'reject', reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  return (
    <article className="approval-card">
      <div>
        <span className="node-type">Approval</span>
        <h3>{approval.nodeId}</h3>
        <p>Invocation {approval.invocationSequence}</p>
      </div>
      <dl>
        <dt>Action</dt>
        <dd>{approval.binding.resolvedAction}</dd>
        <dt>Repository HEAD</dt>
        <dd>{approval.binding.repositoryHead}</dd>
        <dt>Bound artifacts</dt>
        <dd>{approval.binding.artifactChecksums.length}</dd>
      </dl>
      {approval.state === 'waiting_for_approval' ? (
        <>
          <label>
            Decision reason
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} />
          </label>
          <div className="approval-actions">
            <button
              className="reject"
              disabled={busy || !reason.trim()}
              onClick={() => onDecision('reject', reason)}
              type="button"
            >
              Reject
            </button>
            <button
              className="approve"
              disabled={busy || !reason.trim()}
              onClick={() => onDecision('grant', reason)}
              type="button"
            >
              Approve
            </button>
          </div>
        </>
      ) : (
        <span className={stateClass(approval.state)}>{approval.state}</span>
      )}
    </article>
  );
}

export function App() {
  const [runs, setRuns] = useState<readonly RunSummary[]>([]);
  const [selectedRunId, setSelectedRunId] = useState<string>();
  const [run, setRun] = useState<RunDetails>();
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('details');
  const [events, setEvents] = useState<readonly ReplayedEvent[]>([]);
  const [artifacts, setArtifacts] = useState<readonly ArtifactView[]>([]);
  const [activeArtifact, setActiveArtifact] = useState<ArtifactView | null>(null);
  const [approvals, setApprovals] = useState<readonly ApprovalView[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    fetchRuns()
      .then((next) => {
        setRuns(next);
        setSelectedRunId((current) => current ?? next[0]?.id);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Load failed'));
  }, []);

  useEffect(() => {
    if (!selectedRunId) return undefined;
    setEvents([]);
    setActiveArtifact(null);
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
    return reconnectEvents(selectedRunId, 0, (event) => {
      setEvents((current) =>
        current.some(({ id }) => id === event.id) ? current : [...current, event],
      );
    });
  }, [selectedRunId]);

  const nodes = useMemo(() => (run ? graphNodes(run) : []), [run]);
  const edges = useMemo(() => (run ? graphEdges(run) : []), [run]);
  const node = run?.nodes.find(({ id }) => id === selectedNode) ?? null;

  async function openArtifact(artifact: ArtifactView): Promise<void> {
    if (!run) return;
    try {
      setActiveArtifact(await fetchArtifact(run.id, artifact.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Artifact load failed');
    }
  }

  async function submitDecision(
    approval: ApprovalView,
    decision: 'grant' | 'reject',
    reason: string,
  ): Promise<void> {
    if (!run) return;
    setBusy(true);
    try {
      await decideApproval(run.id, approval.invocationSequence, {
        decision,
        actor: 'web-user',
        reason,
        idempotencyKey: crypto.randomUUID(),
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

  return (
    <main>
      <RunList runs={runs} selected={selectedRunId} onSelect={setSelectedRunId} />
      <section className="workspace">
        {error ? <div className="error-banner">{error}</div> : null}
        {run ? (
          <>
            <header className="run-header">
              <div>
                <p className="eyebrow">{run.workflowId}</p>
                <h2>{run.id}</h2>
              </div>
              <div className="run-stat">
                <span className={stateClass(run.status)}>{run.status}</span>
                <small>{run.eventCount} durable events</small>
              </div>
            </header>
            <section className="graph">
              <ReactFlow
                edges={edges}
                fitView
                nodes={nodes}
                nodesConnectable={false}
                nodesDraggable={false}
                onNodeClick={(_, selected) => {
                  setSelectedNode(selected.id);
                  setTab('details');
                }}
              >
                <Background color="#263750" gap={24} />
                <MiniMap nodeColor="#3f74a8" pannable zoomable />
                <Controls showInteractive={false} />
              </ReactFlow>
            </section>
            <section className="inspector">
              <nav className="tabs">
                {(['details', 'events', 'artifacts', 'approval'] as const).map((name) => (
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
                {tab === 'details' ? <NodeDetails node={node} run={run} /> : null}
                {tab === 'events' ? <EventLog events={events} /> : null}
                {tab === 'artifacts' ? (
                  <Artifacts
                    active={activeArtifact}
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
                        key={approval.invocationSequence}
                        onDecision={(decision, reason) =>
                          void submitDecision(approval, decision, reason)
                        }
                      />
                    ))
                  ) : (
                    <p className="empty">This run has no approval records.</p>
                  )
                ) : null}
              </div>
            </section>
          </>
        ) : (
          <div className="loading">Waiting for durable run state…</div>
        )}
      </section>
    </main>
  );
}
