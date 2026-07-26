import '@xyflow/react/dist/style.css';

import type {
  ApprovalView,
  ArtifactView,
  RunDetails,
  RunSummary,
  TicketDetails,
  TicketListItem,
  TicketProjectView,
  TicketProviderConfigurationView,
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
  fetchTicket,
  fetchTicketProjects,
  fetchTicketProviderConfigurations,
  fetchTickets,
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

function ExecutionConsole() {
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
    <div className="execution-layout">
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
          <small>
            Credentials: {configuration.credentialSource.replaceAll('_', ' ')}
          </small>
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
      <nav className="surface-nav">
        <strong>Kairo</strong>
        <button
          className={surface === 'tickets' ? 'active' : ''}
          onClick={() => setSurface('tickets')}
          type="button"
        >
          Tickets
        </button>
        <button
          className={surface === 'runs' ? 'active' : ''}
          onClick={() => setSurface('runs')}
          type="button"
        >
          Runs
        </button>
      </nav>
      {surface === 'tickets' ? <TicketConsole /> : <ExecutionConsole />}
    </main>
  );
}
