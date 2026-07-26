import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { compileAdwPackage } from '@kairo/adw';
import {
  createKairoApp,
  KairoTicketRunQuery,
  LocalArtifactContentReader,
  type KairoApp,
} from '@kairo/api';
import type { CreateRunRequest, CreateRunResponse, RepositorySummary } from '@kairo/api-contracts';
import type { TicketProviderConfigurationView } from '@kairo/api-contracts';
import {
  AgentExecutor,
  type AgentHarness,
  BunCommandRunner,
  RunCoordinator,
  type RunAggregate,
  type TicketProvider,
} from '@kairo/executors';
import {
  ClaudeCodeHarness,
  CodexHarness,
  HarnessRegistry,
  LocalArtifactWriter,
  OpenCodeHarness,
  PiHarness,
} from '@kairo/harnesses';
import { SqliteEventStore } from '@kairo/persistence-sqlite';
import { WorktreeSandboxProvider, type RunWorktree } from '@kairo/sandbox-worktree';
import {
  SqliteTicketRepository,
  SqliteTicketRunStore,
  SqliteTicketSyncStore,
  TicketMigrationService,
  type TicketMigrationError,
  type TicketPriority,
  type TicketProvider as RemoteTicketProvider,
  TicketErrorKind,
  TicketRunService,
  TicketService,
  TicketSyncErrorKind,
  TicketSyncService,
  type TicketSyncError,
  type Ticket,
  type TicketComment,
  type TicketError,
  type TicketStatus,
  type UpdateTicketInput,
  toTicketError,
  toTicketSyncError,
} from '@kairo/tickets';
import { ok, type Result } from '@usersatoshi/results';

import { CliErrorKind, cliErr, type CliError } from './errors.ts';
import { resolveLocalPaths, type LocalPaths } from './paths.ts';
import { composeTicketProviders, type TicketProviderComposition } from './ticket-composition.ts';
import {
  createInlineWorkItem,
  createStoredTicketWorkItem,
  resolveTicketWorkItem,
  workItemConfiguration,
} from './work-item.ts';
import { LocalWorker } from './worker.ts';

interface RunConfiguration {
  readonly worktreePath: string;
  readonly repositoryId: string;
  readonly repositoryPath: string;
  readonly deliveryBranch: string;
  readonly operator: string;
}

function runConfiguration(aggregate: RunAggregate): RunConfiguration | undefined {
  const value = aggregate.state.configuration;
  return typeof value.worktreePath === 'string' &&
    typeof value.repositoryId === 'string' &&
    typeof value.repositoryPath === 'string' &&
    typeof value.deliveryBranch === 'string' &&
    typeof value.operator === 'string'
    ? {
        worktreePath: value.worktreePath,
        repositoryId: value.repositoryId,
        repositoryPath: value.repositoryPath,
        deliveryBranch: value.deliveryBranch,
        operator: value.operator,
      }
    : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : JSON.stringify(error);
}

function repositoryId(path: string): string {
  return `repo-${createHash('sha256').update(resolve(path)).digest('hex').slice(0, 16)}`;
}

function runId(): string {
  return `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function harnessRouteError(
  nodeIds: ReadonlyMap<string, string>,
  routes: Readonly<Record<string, readonly string[]>> | undefined,
): string | undefined {
  if (!routes) return undefined;
  for (const [nodeId, harnesses] of Object.entries(routes)) {
    if (nodeIds.get(nodeId) !== 'agent') {
      return `Harness route ${nodeId} does not name a compiled agent node`;
    }
    if (
      harnesses.length === 0 ||
      harnesses.some((harnessId) => typeof harnessId !== 'string' || !harnessId.trim())
    ) {
      return `Harness route ${nodeId} must contain at least one harness ID`;
    }
  }
  return undefined;
}

/** Mounts the API under `/api` and serves production web assets as an SPA. */
export function createLocalRequestHandler(
  app: KairoApp,
  webRoot: string,
): (request: Request) => Promise<Response> {
  return async (request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      url.pathname = url.pathname.slice(4) || '/';
      return app.fetch(new Request(url, request));
    }
    if (
      url.pathname === '/health' ||
      url.pathname.startsWith('/runs') ||
      url.pathname.startsWith('/workflows') ||
      url.pathname.startsWith('/repositories') ||
      url.pathname.startsWith('/tickets') ||
      url.pathname.startsWith('/ticket-projects') ||
      url.pathname.startsWith('/ticket-providers')
    ) {
      return app.fetch(request);
    }
    const relative = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    const file = Bun.file(resolve(webRoot, relative));
    if (await file.exists()) return new Response(file);
    return new Response(Bun.file(resolve(webRoot, 'index.html')));
  };
}

export class LocalKairoHost {
  readonly store: SqliteEventStore;
  readonly sandbox: WorktreeSandboxProvider;
  readonly worker: LocalWorker;
  private readonly tickets: SqliteTicketRepository;
  private readonly ticketRuns: SqliteTicketRunStore;
  private readonly ticketSync: SqliteTicketSyncStore;
  private readonly ticketService: TicketService;
  private readonly ticketSyncService: TicketSyncService;
  private readonly ticketMigrationService: TicketMigrationService;
  private readonly remoteTicketProviders: ReadonlyMap<'github' | 'forgejo', RemoteTicketProvider>;
  private readonly ticketProviderViews: readonly TicketProviderConfigurationView[];
  private readonly registry: HarnessRegistry;
  private readonly ticketProviders: ReadonlyMap<string, TicketProvider>;
  private readonly artifactWriter: LocalArtifactWriter;
  private initialized = false;

  constructor(
    readonly paths: LocalPaths = resolveLocalPaths(),
    harnesses: readonly AgentHarness[] = [
      new CodexHarness(),
      new ClaudeCodeHarness(),
      new OpenCodeHarness(),
      new PiHarness(),
    ],
    ticketProviders: readonly TicketProvider[] = [],
  ) {
    mkdirSync(paths.dataDirectory, { recursive: true });
    this.store = new SqliteEventStore(paths.databasePath);
    this.tickets = new SqliteTicketRepository(paths.databasePath);
    this.ticketRuns = new SqliteTicketRunStore(paths.databasePath);
    this.ticketSync = new SqliteTicketSyncStore(paths.databasePath);
    const clock = { now: (): string => new Date().toISOString() };
    const ids = {
      ticketId: (): string => `ticket-${randomUUID()}`,
      commentId: (): string => `comment-${randomUUID()}`,
    };
    this.ticketService = new TicketService(this.tickets, clock, ids);
    this.ticketSyncService = new TicketSyncService(
      this.tickets,
      this.ticketSync,
      clock,
      ids,
      this.ticketRuns,
      new KairoTicketRunQuery(this.store),
    );
    this.ticketMigrationService = new TicketMigrationService(this.tickets, this.ticketSync, clock);
    const ticketComposition: TicketProviderComposition = composeTicketProviders(
      process.env,
      this.ticketSync,
    );
    this.remoteTicketProviders = ticketComposition.providers;
    this.ticketProviderViews = ticketComposition.configurations;
    this.sandbox = new WorktreeSandboxProvider(paths.worktreeDirectory);
    this.artifactWriter = new LocalArtifactWriter(paths.artifactDirectory);
    this.registry = new HarnessRegistry(harnesses);
    this.ticketProviders = new Map(ticketProviders.map((provider) => [provider.id, provider]));
    this.worker = new LocalWorker(this.store, {
      coordinatorFor: (aggregate) => this.coordinatorFor(aggregate),
      finalize: (aggregate) => this.finalize(aggregate),
    });
  }

  async initialize(): Promise<Result<void, CliError>> {
    try {
      await Promise.all([
        mkdir(this.paths.dataDirectory, { recursive: true }),
        mkdir(this.paths.configDirectory, { recursive: true }),
        mkdir(this.paths.artifactDirectory, { recursive: true }),
      ]);
      const store = this.store.initialize();
      if (store.isErr()) {
        return cliErr(
          CliErrorKind.Initialization,
          'sqlite_initialization_failed',
          'The SQLite store could not be initialized',
        );
      }
      for (const ticketStore of [this.tickets, this.ticketRuns, this.ticketSync]) {
        const initialized = ticketStore.initialize();
        if (initialized.isErr()) {
          return cliErr(
            CliErrorKind.Initialization,
            'sqlite_ticket_initialization_failed',
            'The SQLite ticket stores could not be initialized',
          );
        }
      }
      const sandbox = await this.sandbox.initialize();
      if (sandbox.isErr()) {
        return cliErr(
          CliErrorKind.Initialization,
          'worktree_initialization_failed',
          message(sandbox.error),
        );
      }
      await this.worker.recover();
      this.initialized = true;
      return ok(undefined);
    } catch (cause) {
      return cliErr(CliErrorKind.Initialization, 'initialization_failed', message(cause));
    }
  }

  async create(request: CreateRunRequest): Promise<Result<CreateRunResponse, CliError>> {
    const ticket = request.ticket?.trim();
    if (ticket?.startsWith('kairo:')) {
      return this.createTicketRun(request, ticket.slice('kairo:'.length).trim());
    }
    return this.createRun(request);
  }

  private async createRun(
    request: CreateRunRequest,
    suppliedWorkItem?: import('@kairo/domain').WorkItemSnapshot,
  ): Promise<Result<CreateRunResponse, CliError>> {
    if (!this.initialized) {
      return cliErr(
        CliErrorKind.Initialization,
        'host_not_initialized',
        'Kairo is not initialized',
      );
    }
    const packageDirectory =
      request.adw === 'feature-development'
        ? resolve(import.meta.dir, '..', 'assets', 'adws', 'feature-development')
        : resolve(request.adw);
    const compiled = await compileAdwPackage(packageDirectory);
    if (compiled.isErr()) {
      return cliErr(CliErrorKind.Compilation, 'adw_compilation_failed', message(compiled.error));
    }
    const routeError = harnessRouteError(
      new Map(compiled.unwrap().bundle.nodes.map(({ id, type }) => [id, type])),
      request.harnessesByNode,
    );
    if (routeError) {
      return cliErr(CliErrorKind.InvalidArguments, 'invalid_harness_route', routeError);
    }
    const task = request.task?.trim();
    const ticket = request.ticket?.trim();
    if (request.task !== undefined && !task) {
      return cliErr(
        CliErrorKind.InvalidArguments,
        'invalid_work_item',
        'Task text must be non-empty',
      );
    }
    if (request.ticket !== undefined && !ticket) {
      return cliErr(
        CliErrorKind.InvalidArguments,
        'invalid_ticket_reference',
        'Ticket reference must be non-empty',
      );
    }
    if (task && ticket) {
      return cliErr(
        CliErrorKind.InvalidArguments,
        'multiple_work_items',
        'Use exactly one of task or ticket',
      );
    }
    if (request.adw === 'feature-development' && !task && !ticket && !suppliedWorkItem) {
      return cliErr(
        CliErrorKind.InvalidArguments,
        'work_item_required',
        'feature-development requires --ticket, --task, or --task-file',
      );
    }
    const workItem = suppliedWorkItem
      ? ok(suppliedWorkItem)
      : task
        ? createInlineWorkItem(task)
        : ticket
          ? await resolveTicketWorkItem(ticket, this.ticketProviders)
          : undefined;
    if (workItem?.isErr()) {
      return cliErr(CliErrorKind.InvalidArguments, workItem.error.code, workItem.error.message);
    }
    const id = runId();
    const repoId = repositoryId(request.repositoryPath);
    const registered = await this.sandbox.registerRepository(repoId, request.repositoryPath);
    if (registered.isErr()) {
      return cliErr(
        CliErrorKind.Repository,
        'repository_registration_failed',
        message(registered.error),
      );
    }
    const pinned = await this.sandbox.pinStartingCommit(registered.unwrap());
    if (pinned.isErr()) {
      return cliErr(CliErrorKind.Repository, 'starting_commit_failed', message(pinned.error));
    }
    const worktree = await this.sandbox.createWorktree(pinned.unwrap(), id);
    if (worktree.isErr()) {
      return cliErr(CliErrorKind.Repository, 'worktree_creation_failed', message(worktree.error));
    }
    const harnesses = request.harnesses?.length
      ? request.harnesses
      : ['codex', 'claude-code', 'opencode', 'pi'];
    const created = this.coordinator(worktree.unwrap().path).createRun({
      runId: id,
      artifact: compiled.unwrap(),
      startingCommit: pinned.unwrap().startingCommit,
      configuration: {
        adw: request.adw,
        agentHarnesses: harnesses,
        ...(request.harnessesByNode ? { agentHarnessesByNode: request.harnessesByNode } : {}),
        ...(workItem?.isOk() ? { workItem: workItemConfiguration(workItem.unwrap()) } : {}),
        requestedPermissions: compiled.unwrap().bundle.permissions ?? [],
        repositoryId: repoId,
        repositoryPath: pinned.unwrap().repositoryPath,
        worktreePath: worktree.unwrap().path,
        deliveryBranch: `kairo/${id}`,
        operator: request.actor,
      },
      idempotencyKey: `create:${id}`,
    });
    if (created.isErr()) {
      return cliErr(CliErrorKind.Persistence, 'run_creation_failed', message(created.error));
    }
    const stable = await this.worker.runUntilStable(id);
    return ok({ runId: id, status: stable.state.status });
  }

  private async createTicketRun(
    request: CreateRunRequest,
    ticketId: string,
  ): Promise<Result<CreateRunResponse, CliError>> {
    if (!ticketId) {
      return cliErr(
        CliErrorKind.InvalidArguments,
        'invalid_ticket_reference',
        'Kairo ticket references must use kairo:<ticket-id>',
      );
    }
    if (request.task !== undefined) {
      return cliErr(
        CliErrorKind.InvalidArguments,
        'multiple_work_items',
        'Use exactly one of task or ticket',
      );
    }
    let response: CreateRunResponse | undefined;
    const service = new TicketRunService(
      this.tickets,
      this.ticketRuns,
      new KairoTicketRunQuery(this.store),
      {
        start: async ({ ticket, snapshot }) => {
          const workItem = createStoredTicketWorkItem(ticket, snapshot);
          if (workItem.isErr()) {
            return toTicketError(TicketErrorKind.InvalidInput, {
              field: 'ticketId',
              reason: workItem.error.message,
            });
          }
          const created = await this.createRun(
            { ...request, ticket: undefined },
            workItem.unwrap(),
          );
          if (created.isErr()) {
            return toTicketError(TicketErrorKind.InvalidInput, {
              field: 'ticketId',
              reason: created.error.message,
            });
          }
          response = created.unwrap();
          return ok({ runId: response.runId });
        },
      },
      { now: (): string => new Date().toISOString() },
      {
        ticketId: (): string => `ticket-${randomUUID()}`,
        commentId: (): string => `comment-${randomUUID()}`,
        snapshotId: (): string => `snapshot-${randomUUID()}`,
      },
    );
    const started = await service.start({
      ticketId,
      kind: 'implementation',
      workflow: request.adw,
      repositoryPath: request.repositoryPath,
      actor: request.actor,
    });
    if (started.isErr()) {
      return cliErr(
        CliErrorKind.InvalidArguments,
        'ticket_run_failed',
        JSON.stringify(started.error),
      );
    }
    return response
      ? ok(response)
      : cliErr(
          CliErrorKind.Persistence,
          'ticket_run_missing',
          'Ticket run started without a run response',
        );
  }

  coordinatorFor(aggregate: RunAggregate): RunCoordinator {
    const configuration = runConfiguration(aggregate);
    return this.coordinator(configuration?.worktreePath ?? process.cwd());
  }

  coordinator(workingDirectory = process.cwd()): RunCoordinator {
    return new RunCoordinator(
      this.store,
      new BunCommandRunner(workingDirectory),
      new AgentExecutor(this.registry, this.artifactWriter),
      workingDirectory,
    );
  }

  app() {
    return createKairoApp({
      runs: this.store,
      coordinator: this.coordinator(),
      artifacts: new LocalArtifactContentReader(this.paths.artifactDirectory),
      repositories: this,
      runCreator: this,
      tickets: {
        repository: this.tickets,
        runs: this.ticketRuns,
        runQuery: new KairoTicketRunQuery(this.store),
        sync: this.ticketSync,
      },
      ticketProviders: { list: () => this.ticketProviderViews },
    });
  }

  createTicket(input: {
    readonly projectId: string;
    readonly title: string;
    readonly description: string;
    readonly priority?: TicketPriority;
    readonly labels?: readonly string[];
    readonly assignees?: readonly string[];
  }): Result<Ticket, TicketError> {
    return this.ticketService.create(input);
  }

  listTickets(projectId: string): Result<readonly Ticket[], TicketError> {
    return this.ticketService.list(projectId);
  }

  getTicket(ticketId: string): Result<Ticket, TicketError> {
    return this.ticketService.get(ticketId);
  }

  updateTicket(ticketId: string, input: UpdateTicketInput): Result<Ticket, TicketError> {
    return this.ticketService.update(ticketId, input);
  }

  moveTicket(
    ticketId: string,
    expectedRevision: number,
    status: TicketStatus,
  ): Result<Ticket, TicketError> {
    return this.ticketService.move(ticketId, expectedRevision, status);
  }

  closeTicket(ticketId: string, expectedRevision: number): Result<Ticket, TicketError> {
    return this.ticketService.close(ticketId, expectedRevision);
  }

  cancelTicket(ticketId: string, expectedRevision: number): Result<Ticket, TicketError> {
    return this.ticketService.cancel(ticketId, expectedRevision);
  }

  reopenTicket(ticketId: string, expectedRevision: number): Result<Ticket, TicketError> {
    return this.ticketService.reopen(ticketId, expectedRevision);
  }

  addTicketComment(
    ticketId: string,
    author: string,
    body: string,
  ): Result<TicketComment, TicketError> {
    return this.ticketService.addComment(ticketId, { author, body });
  }

  async importTickets(
    providerId: 'github' | 'forgejo',
    projectId: string,
  ): Promise<Result<readonly Ticket[], TicketSyncError> | undefined> {
    const provider = this.remoteTicketProviders.get(providerId);
    return provider ? this.ticketSyncService.importProject(projectId, provider) : undefined;
  }

  async pullTicket(ticketId: string): Promise<Result<Ticket, TicketSyncError> | undefined> {
    const ticket = this.ticketService.get(ticketId);
    if (ticket.isErr()) {
      return toTicketSyncError(TicketSyncErrorKind.Ticket, { error: ticket.error });
    }
    if (ticket.value.binding.kind === 'local') return undefined;
    const provider = this.remoteTicketProviders.get(ticket.value.binding.kind);
    return provider ? this.ticketSyncService.reconcile(ticketId, provider) : undefined;
  }

  async pushTicket(
    ticketId: string,
    idempotencyKey: string,
  ): Promise<Result<Ticket, TicketSyncError> | undefined> {
    const ticket = this.ticketService.get(ticketId);
    if (ticket.isErr()) {
      return toTicketSyncError(TicketSyncErrorKind.Ticket, { error: ticket.error });
    }
    if (ticket.value.binding.kind === 'local') return undefined;
    const provider = this.remoteTicketProviders.get(ticket.value.binding.kind);
    return provider
      ? this.ticketSyncService.syncTicket(ticketId, provider, idempotencyKey)
      : undefined;
  }

  async migrateTicket(
    ticketId: string,
    projectId: string,
    providerId: 'github' | 'forgejo',
  ): Promise<Result<Ticket, TicketMigrationError> | undefined> {
    const provider = this.remoteTicketProviders.get(providerId);
    return provider
      ? this.ticketMigrationService.migrate(ticketId, projectId, provider)
      : undefined;
  }

  ticketProviderConfigurations(): readonly TicketProviderConfigurationView[] {
    return this.ticketProviderViews;
  }

  async list(): Promise<readonly RepositorySummary[]> {
    const directory = resolve(this.paths.worktreeDirectory, 'repositories');
    try {
      const files = (await readdir(directory)).filter((file) => file.endsWith('.json')).toSorted();
      const repositories: RepositorySummary[] = [];
      for (const file of files) {
        const parsed: unknown = JSON.parse(await readFile(resolve(directory, file), 'utf8'));
        if (
          isRecord(parsed) &&
          typeof parsed.repositoryId === 'string' &&
          typeof parsed.repositoryPath === 'string'
        ) {
          repositories.push({ id: parsed.repositoryId, path: parsed.repositoryPath });
        }
      }
      return repositories;
    } catch {
      return [];
    }
  }

  harnessDiagnostics(): readonly { id: string; available: boolean }[] {
    return [
      { id: 'codex', available: Bun.which('codex') !== null },
      { id: 'claude-code', available: Bun.which('claude') !== null },
      { id: 'opencode', available: Bun.which('opencode') !== null },
      { id: 'pi', available: Bun.which('pi') !== null },
    ];
  }

  async serve(port = 4317): Promise<Result<{ readonly url: string; stop(): void }, CliError>> {
    if (!this.initialized) {
      return cliErr(
        CliErrorKind.Initialization,
        'host_not_initialized',
        'Kairo is not initialized',
      );
    }
    const app = this.app();
    const webRoot = resolve(import.meta.dir, '..', '..', 'web', 'dist');
    const fetch = createLocalRequestHandler(app, webRoot);
    try {
      this.worker.start();
      const server = Bun.serve({
        port,
        fetch,
      });
      return ok({
        url: `http://${server.hostname}:${server.port}`,
        stop: () => server.stop(true),
      });
    } catch (cause) {
      return cliErr(CliErrorKind.Serve, 'serve_failed', message(cause));
    }
  }

  dispose(): void {
    this.worker.dispose();
    this.ticketSync.dispose();
    this.ticketRuns.dispose();
    this.tickets.dispose();
    this.store.dispose();
    this.initialized = false;
  }

  private async finalize(aggregate: RunAggregate): Promise<void> {
    if (
      aggregate.state.artifacts?.some(({ id }) => id === '0:0:git_diff') ||
      !aggregate.state.invocations.some(({ state, nodeId }) => {
        const definition = aggregate.artifact.bundle.nodes.find(({ id }) => id === nodeId);
        return (
          state === 'pending' && definition?.type === 'complete' && definition.result !== 'failed'
        );
      })
    ) {
      return;
    }
    const configuration = runConfiguration(aggregate);
    if (!configuration) throw new Error(`Run ${aggregate.runId} has invalid local configuration`);
    const worktree: RunWorktree = {
      repositoryId: configuration.repositoryId,
      runId: aggregate.runId,
      repositoryPath: configuration.repositoryPath,
      path: configuration.worktreePath,
      commonGitDirectory: resolve(configuration.repositoryPath, '.git'),
      startingCommit: aggregate.state.startingCommit,
    };
    const metadataPath = resolve(
      this.paths.worktreeDirectory,
      'runs',
      configuration.repositoryId,
      `${aggregate.runId}.json`,
    );
    const recorded: unknown = JSON.parse(await readFile(metadataPath, 'utf8'));
    if (!isRecord(recorded) || typeof recorded.commonGitDirectory !== 'string') {
      throw new Error('Run worktree metadata is corrupt');
    }
    const durableWorktree = { ...worktree, commonGitDirectory: recorded.commonGitDirectory };
    const captured = await this.sandbox.captureArtifacts(durableWorktree);
    if (captured.isErr()) throw new Error(message(captured.error));
    let current = aggregate;
    for (const source of [captured.unwrap().status, captured.unwrap().diff]) {
      const kind = source.kind === 'status' ? 'git_status' : 'git_diff';
      const content = await readFile(source.path, 'utf8');
      const written = await this.artifactWriter.write({
        runId: aggregate.runId,
        invocationSequence: 0,
        attemptNumber: 0,
        kind,
        mediaType: kind === 'git_diff' ? 'text/x-diff' : 'text/plain',
        content,
      });
      if (written.isErr()) throw new Error(written.error.message);
      const published = this.coordinatorFor(current).publishRunArtifact(
        current.runId,
        written.unwrap(),
        `final:${kind}`,
      );
      if (published.isErr()) throw new Error(message(published.error));
      current = published.unwrap();
    }
    const prepared = await this.sandbox.prepareCommit(durableWorktree);
    if (prepared.isErr()) throw new Error(message(prepared.error));
    const committed = await this.sandbox.commitWorktree({
      worktree: durableWorktree,
      expectedHead: prepared.unwrap().head,
      expectedTree: prepared.unwrap().tree,
      message: `Kairo delivery ${aggregate.runId}`,
      identity: { name: 'Kairo', email: 'kairo@localhost' },
      timestamp: aggregate.state.startedAt ?? new Date(0).toISOString(),
    });
    if (committed.isErr()) throw new Error(message(committed.error));
    const branched = await this.sandbox.createDeliveryBranch(
      durableWorktree,
      configuration.deliveryBranch,
      committed.unwrap().commit,
    );
    if (branched.isErr()) throw new Error(message(branched.error));
  }
}
