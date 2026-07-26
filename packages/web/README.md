# `@kairo/web` — Execution Console Dashboard

Read-only Kairo execution console built with **React 19**, **Vite**, and **React Flow** (`@xyflow/react`). Displays runs, workflow state graphs, node invocations/attempts, reconnectable durable events, logs, artifacts, diffs, and artifact-bound approval controls.

## Design Constraints

- **Read-only execution console** — The graph is not editable (`nodesConnectable={false}`, `nodesDraggable={false}`)
- **The browser cannot supply an approval binding** — Approvals are submitted by a human operator ("web-user") but cryptographic/state bindings happen server-side
- **Live event replay** — Events are delivered via Server-Sent Events (SSE) with `lastEventId` tracking for resilient reconnection

## Quick Start

```bash
# Development (with HMR, proxying /api to localhost:3000)
bun run dev

# Production build
bun run build
```

Output goes to `dist/` (static files served by the Kairo CLI's `serve` command or any HTTP server).

## Architecture

```
App (root component)
├── RunList (sidebar)
│   └── All runs with status badges
└── Workspace (main area)
    ├── Error banner (conditional)
    ├── Run Header
    │   └── Workflow ID, run ID, status, event count
    ├── Graph (React Flow)
    │   └── DAG of workflow nodes/edges with color-coded state
    └── Inspector (tabbed panel)
        ├── "details" tab → NodeDetails
        │   └── Node definition + invocations + attempts
        ├── "events" tab → EventLog
        │   └── SSE-driven durable replayed events
        ├── "artifacts" tab → Artifacts
        │   └── Artifact list + content viewer
        └── "approval" tab → ApprovalControl
            └── Grant/reject with reason
```

## Data Flow

1. **Mount** → `fetchRuns()` populates the run list sidebar
2. **Run selection** → `fetchRun()`, `fetchArtifacts()`, `fetchApprovals()` in parallel
3. **SSE stream** → `reconnectEvents()` opens an `EventSource` for live durable events
4. **Event deduplication** → Incoming events are deduplicated by `id` before appending to the event log
5. **Node click** → Inspector switches to "details" tab showing that node's invocations/attempts
6. **Artifact click** → Content fetched on demand via `fetchArtifact()`
7. **Approval action** → `decideApproval()` POSTs grant/reject; on success, run state and approvals are re-fetched

## API Client

The `api.ts` module provides:

```typescript
import {
  fetchRuns,
  fetchRun,
  fetchApprovals,
  fetchArtifacts,
  fetchArtifact,
  decideApproval,
  reconnectEvents,
} from '@kairo/web/api';

// List all runs
const runs = await fetchRuns();

// Get run details
const details = await fetchRun('run-abc');

// SSE event stream
const close = reconnectEvents('run-abc', lastEventId, (event) => {
  console.log(event.type, event.data);
});
// Call close() to disconnect
```

### SSE Events

`reconnectEvents` listens for both generic `message` events and 20 named event types covering the full Kairo lifecycle:

- Run lifecycle: `run.created`, `run.paused`, `run.resumed`, `run.cancelled`, `run.completed`
- Invocation lifecycle: `invocation.activated`, `invocation.completed`, `invocation.skipped`, `invocation.retry_requested`
- Attempt lifecycle: `attempt.started`, `attempt.resumed`, `attempt.resume_token_recorded`, `attempt.artifact_published`, `attempt.failed`, `attempt.interrupted`, `attempt.interrupt_requested`
- Artifacts: `run.artifact_published`
- Approval: `approval.requested`, `approval.granted`, `approval.rejected`

### Runtime Validation

Each API response is validated through runtime type guards (`isRunSummary`, `isRunDetails`, `isApprovalView`, `isArtifactView`). On validation failure, an `Error` is thrown with a descriptive message.

## Visual Design

Dark theme with color-coded state indicators:

| State | Color |
|-------|-------|
| `succeeded` | Green |
| `failed` / `rejected` | Red |
| `running` / `active` | Blue |
| `waiting_for_approval` | Amber |
| `pending` | Gray |
| `interrupted` / `cancelled` | Orange |

Layout: 260px sidebar + flexible main area with a DAG graph and tabbed inspector panel.

## Vite Dev Proxy

The dev server proxies `/api/*` to `http://localhost:3000` (the Kairo CLI serve command). The `/api` prefix is stripped before forwarding:

```typescript
// vite.config.ts
server: {
  proxy: {
    '/api': {
      target: 'http://localhost:3000',
      rewrite: (path) => path.replace(/^\/api/, ''),
    },
  },
},
```

## Build and Deployment

```bash
# Build
bun run build

# Output:
# dist/index.html
# dist/assets/index-<hash>.css
# dist/assets/index-<hash>.js

# Serve via Kairo CLI
bun run kairo serve
```

The Kairo CLI (`kairo serve`) serves the production build from its own HTTP server with SPA fallback (all routes not matching `/api/*` serve `index.html`).

## Dependencies

| Dependency | Version | Purpose |
|------------|---------|---------|
| `@kairo/api-contracts` | workspace:* | TypeScript interfaces for API shapes |
| `@xyflow/react` | ^12.11.2 | React Flow DAG graph rendering |
| `react` | ^19.2.8 | UI framework |
| `react-dom` | ^19.2.8 | React DOM renderer |

## Dev Dependencies

| Dependency | Purpose |
|------------|---------|
| `@types/react`, `@types/react-dom` | TypeScript types |
| `@vitejs/plugin-react` | Vite React plugin |
| `vite` | Build tool and dev server |
