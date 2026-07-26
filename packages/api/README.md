# `@kairo/api` — HTTP API and Application Use Cases

The application layer of Kairo, implementing a hexagonal/ports-and-adapters architecture. Provides an Elysia HTTP server with 19 routes, application use cases, declared port interfaces, a single-process composition root, and checksum-verifying local artifact reader.

## Architecture

```
Transport (HTTP)
    ↓
@kairo/api (application layer)
    ├── app.ts              — Elysia route definitions
    ├── use-cases.ts        — application orchestration logic
    ├── ports.ts            — declared port interfaces
    ├── errors.ts           — ApiError type
    ├── composition-root.ts — DI wiring for single-process MVP
    └── local-artifact-content-reader.ts — filesystem artifact reader
    ↓
Domain and runtime (@kairo/domain, @kairo/executors)
    ↓
Infrastructure (implemented by other packages)
```

## HTTP API (Elysia Routes)

The `createKairoApp(services)` factory produces an Elysia instance with **19 routes**:

### Health

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Liveness probe (returns `{ status: 'ok' }`) |

### Runs

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/runs` | List all runs |
| `POST` | `/runs` | Create a new run |
| `GET` | `/runs/:runId` | Get run details with graph view |
| `GET` | `/runs/:runId/events` | SSE event stream (optional `?after=`) |
| `GET` | `/runs/:runId/artifacts` | List all artifacts |
| `GET` | `/runs/:runId/artifacts/:artifactId` | Get artifact (with optional content) |
| `GET` | `/runs/:runId/approvals` | List pending/historical approvals |
| `POST` | `/runs/:runId/approvals/:invocationSequence` | Grant or reject approval |
| `POST` | `/runs/:runId/:action` | Pause, resume, or cancel a run |
| `POST` | `/runs/:runId/invocations/:invocationSequence/:action` | Interrupt, retry, or skip an invocation |

### Workflows

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/workflows` | List unique compiled workflows |
| `GET` | `/workflows/:checksum` | Get workflow with full bundle |

### Repositories

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/repositories` | List registered git repositories |
| `GET` | `/repositories/:repositoryId` | Get repository details |

### Tickets

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/ticket-projects` | List projects containing tickets |
| `GET` | `/tickets?projectId=` | List unified planning/execution board cards |
| `GET` | `/tickets/:ticketId` | Get ticket details and durable histories |
| `GET` | `/ticket-providers` | List redacted provider configuration |

## Use Cases

All use cases receive an `ApiServices` object (injected port implementations) and return `Result<T, ApiError>`.

| Function | Returns | Description |
|----------|---------|-------------|
| `listRuns` | `readonly RunSummary[]` | All runs with summary data |
| `getRun` | `RunDetails` | Single run with graph views |
| `listEvents` | `readonly EventStreamMessage[]` | Events after a sequence number |
| `listArtifacts` | `readonly ArtifactView[]` | All artifacts for a run |
| `getArtifact` | `ArtifactView` | Single artifact (optional content) |
| `listApprovals` | `readonly ApprovalView[]` | Approvals for a run |
| `decideApproval` | `ApprovalDecisionResponse` | Grant or reject |
| `createRun` | `CreateRunResponse` | Create run (delegates to `LocalRunCreator`) |
| `controlRun` | `LifecycleResponse` | Pause / resume / cancel |
| `controlInvocation` | `LifecycleResponse` | Interrupt / retry / skip |
| `listWorkflows` | `readonly WorkflowSummary[]` | Unique workflows |
| `getWorkflow` | `WorkflowDetails` | Workflow with bundle |
| `listRepositories` | `readonly RepositorySummary[]` | All repositories |
| `getRepository` | `RepositorySummary` | Single repository |

## Port Interfaces

The `ports.ts` file declares the contracts that infrastructure must implement:

```typescript
interface ObservableRunStore {
  loadRun(runId: string): Result<RunAggregate, RunStoreError>;
  listRuns(): Result<readonly RunAggregate[], RunStoreError>;
}

interface ArtifactContentReader {
  read(runId, artifact, invocationSequence?, attemptNumber?): Promise<Result<ArtifactContent, Error>>;
}

interface RepositoryQuery {
  list(): Promise<readonly RepositorySummary[]>;
}

interface LocalRunCreator {
  create(request: CreateRunRequest): Promise<Result<CreateRunResponse, Error>>;
}
```

Optional ports (`artifacts`, `repositories`, `runCreator`) degrade gracefully when unavailable.

## Composition Root

The `composeKairoApp(databasePath, artifactRoot?)` function wires up the single-process MVP:

```typescript
import { composeKairoApp } from '@kairo/api';

const composed = composeKairoApp('/path/to/kairo.sqlite', '/path/to/artifacts');
if (composed.isOk()) {
  const { app, dispose } = composed.unwrap();
  // app is the Elysia instance, ready to handle requests
  // Call dispose() to shut down the store
}
```

The composition creates:
1. `SqliteEventStore` — event-sourced persistence
2. `RunCoordinator` — run orchestration with `BunCommandRunner`
3. `LocalArtifactContentReader` — filesystem artifact reads
4. `createKairoApp(services)` — the Elysia app

### Eden Client

`createKairoClient(baseUrl)` creates a typed Eden treaty client for the dashboard:

```typescript
import { createKairoClient } from '@kairo/api';
const client = createKairoClient('http://localhost:4317');
// Fully typed API client
```

## Error Handling

```typescript
const enum ApiErrorKind {
  NotFound = 0,       // maps to 404
  InvalidInput = 1,   // maps to 400
  Conflict = 2,       // maps to 409
  Persistence = 3,    // maps to 500
  ArtifactRead = 4,   // maps to 500
}
```

The `failure()` helper maps `ApiErrorKind` to HTTP status codes.

## SSE Event Streaming

The events endpoint (`GET /runs/:runId/events`) returns `text/event-stream` with:
- Support for `?after=` query parameter and `last-event-id` header
- `retry: 1000` directive for reconnection
- One `EventStreamMessage` per event

## Testing

```typescript
import { createKairoApp } from '@kairo/api';

const app = createKairoApp(mockServices);
const response = await app.handle(
  new Request('http://localhost/runs')
);
// No network port required — transport is testable in-process
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `elysia` | HTTP framework |
| `@elysiajs/eden` | Typed HTTP client |
| `@kairo/api-contracts` | Request/response DTOs |
| `@kairo/domain` | Domain types |
| `@kairo/executors` | RunCoordinator, RunAggregate |
| `@kairo/persistence-sqlite` | SqliteEventStore |
| `@usersatoshi/results` | Result type |
