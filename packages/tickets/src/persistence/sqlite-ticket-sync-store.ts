import { Database } from 'bun:sqlite';

import { safeCall, type Result } from '@usersatoshi/results';

import type { TicketError } from '../errors.ts';
import { TicketErrorKind, toErr } from '../errors.ts';
import type {
  ForgejoMetadataStore,
  TicketHistoryStore,
  TicketMigrationStore,
  TicketSyncStore,
} from '../integration/ports.ts';
import type {
  ExternalTicketEvent,
  ForgejoInstanceMetadata,
  TicketMigration,
  TicketSyncOperation,
  TicketSyncState,
} from '../integration/types.ts';
import type { TicketBinding, TicketStatus } from '../domain/types.ts';
import type { ProviderTicket, TicketProviderCapabilities } from '../provider/types.ts';

interface SyncStateRow {
  readonly ticket_id: string;
  readonly provider: TicketSyncState['provider'];
  readonly status: TicketSyncState['status'];
  readonly last_synced_at: string | null;
  readonly last_error: string | null;
  readonly next_retry_at: string | null;
}

interface ForgejoMetadataRow {
  readonly instance_url: string;
  readonly version: string;
  readonly api_version: string | null;
  readonly capabilities_json: string;
  readonly last_checked_at: string;
}

interface MigrationRow {
  readonly state_json: string;
}

interface SyncOperationRow {
  readonly idempotency_key: string;
  readonly ticket_id: string;
  readonly provider: TicketSyncOperation['provider'];
  readonly operation: string;
  readonly status: TicketSyncOperation['status'];
  readonly last_error: string | null;
  readonly updated_at: string;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
    ? value
    : undefined;
}

function parseBinding(value: unknown): TicketBinding | undefined {
  if (!isRecord(value) || typeof value.kind !== 'string') return undefined;
  if (value.kind === 'local') return { kind: 'local' };
  if (
    (value.kind !== 'github' && value.kind !== 'forgejo') ||
    typeof value.owner !== 'string' ||
    typeof value.repository !== 'string' ||
    typeof value.issueNumber !== 'number' ||
    typeof value.externalUrl !== 'string'
  ) {
    return undefined;
  }
  const revision =
    typeof value.lastSyncedRevision === 'string'
      ? { lastSyncedRevision: value.lastSyncedRevision }
      : {};
  return value.kind === 'github'
    ? {
        kind: value.kind,
        owner: value.owner,
        repository: value.repository,
        issueNumber: value.issueNumber,
        externalUrl: value.externalUrl,
        ...revision,
      }
    : typeof value.instanceUrl === 'string'
      ? {
          kind: value.kind,
          instanceUrl: value.instanceUrl,
          owner: value.owner,
          repository: value.repository,
          issueNumber: value.issueNumber,
          externalUrl: value.externalUrl,
          ...revision,
        }
      : undefined;
}

function parseProviderTicket(value: unknown): ProviderTicket | undefined {
  if (!isRecord(value)) return undefined;
  const binding = parseBinding(value.binding);
  const labels = parseStringArray(value.labels);
  const assignees = parseStringArray(value.assignees);
  if (
    !binding ||
    binding.kind === 'local' ||
    typeof value.title !== 'string' ||
    typeof value.description !== 'string' ||
    (value.status !== 'backlog' && value.status !== 'done') ||
    !labels ||
    !assignees ||
    typeof value.revision !== 'string' ||
    typeof value.updatedAt !== 'string'
  ) {
    return undefined;
  }
  return {
    binding,
    title: value.title,
    description: value.description,
    ...(typeof value.marker === 'string' ? { marker: value.marker } : {}),
    status: value.status,
    labels,
    assignees,
    ...(typeof value.milestone === 'string' ? { milestone: value.milestone } : {}),
    revision: value.revision,
    updatedAt: value.updatedAt,
  };
}

function isTicketStatus(value: unknown): value is TicketStatus {
  return (
    value === 'backlog' ||
    value === 'ready' ||
    value === 'blocked' ||
    value === 'done' ||
    value === 'cancelled'
  );
}

function parseMigration(value: string): TicketMigration {
  const parsed: unknown = JSON.parse(value);
  if (!isRecord(parsed) || !isRecord(parsed.snapshot)) {
    throw new Error('Stored ticket migration is malformed');
  }
  const labels = parseStringArray(parsed.snapshot.labels);
  const assignees = parseStringArray(parsed.snapshot.assignees);
  const remoteTicket =
    parsed.remoteTicket === undefined ? undefined : parseProviderTicket(parsed.remoteTicket);
  if (
    typeof parsed.ticketId !== 'string' ||
    (parsed.targetProvider !== 'github' && parsed.targetProvider !== 'forgejo') ||
    typeof parsed.projectId !== 'string' ||
    typeof parsed.marker !== 'string' ||
    (parsed.stage !== 'prepared' &&
      parsed.stage !== 'remote_created' &&
      parsed.stage !== 'verified' &&
      parsed.stage !== 'completed') ||
    typeof parsed.snapshot.revision !== 'number' ||
    typeof parsed.snapshot.title !== 'string' ||
    typeof parsed.snapshot.description !== 'string' ||
    !isTicketStatus(parsed.snapshot.status) ||
    !labels ||
    !assignees ||
    (parsed.remoteTicket !== undefined && !remoteTicket) ||
    (parsed.lastError !== undefined && typeof parsed.lastError !== 'string') ||
    typeof parsed.createdAt !== 'string' ||
    typeof parsed.updatedAt !== 'string'
  ) {
    throw new Error('Stored ticket migration is malformed');
  }
  return {
    ticketId: parsed.ticketId,
    targetProvider: parsed.targetProvider,
    projectId: parsed.projectId,
    marker: parsed.marker,
    stage: parsed.stage,
    snapshot: {
      revision: parsed.snapshot.revision,
      title: parsed.snapshot.title,
      description: parsed.snapshot.description,
      status: parsed.snapshot.status,
      labels,
      assignees,
    },
    ...(remoteTicket === undefined ? {} : { remoteTicket }),
    ...(typeof parsed.lastError === 'string' ? { lastError: parsed.lastError } : {}),
    createdAt: parsed.createdAt,
    updatedAt: parsed.updatedAt,
  };
}

function parseCapabilities(value: string): TicketProviderCapabilities {
  const parsed: unknown = JSON.parse(value);
  if (
    !isRecord(parsed) ||
    typeof parsed.issues !== 'boolean' ||
    typeof parsed.comments !== 'boolean' ||
    typeof parsed.labels !== 'boolean' ||
    typeof parsed.assignees !== 'boolean' ||
    typeof parsed.milestones !== 'boolean' ||
    typeof parsed.webhooks !== 'boolean' ||
    typeof parsed.projects !== 'boolean'
  ) {
    throw new Error('Stored Forgejo capabilities are malformed');
  }
  return {
    issues: parsed.issues,
    comments: parsed.comments,
    labels: parsed.labels,
    assignees: parsed.assignees,
    milestones: parsed.milestones,
    webhooks: parsed.webhooks,
    projects: parsed.projects,
  };
}

function databaseError(operation: string, error: unknown): TicketError {
  return toErr(TicketErrorKind.DatabaseFailure, {
    operation,
    message: error instanceof Error ? error.message : 'SQLite ticket-sync operation failed',
  });
}

export class SqliteTicketSyncStore
  implements ForgejoMetadataStore, TicketHistoryStore, TicketMigrationStore, TicketSyncStore
{
  private readonly database: Database;

  constructor(path: string) {
    this.database = new Database(path, { create: true, strict: true });
  }

  initialize(): Result<void, TicketError> {
    return safeCall(
      () => {
        this.database.exec('PRAGMA foreign_keys = ON');
        this.database.exec('PRAGMA journal_mode = WAL');
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS ticket_sync_state (
            ticket_id TEXT PRIMARY KEY,
            provider TEXT NOT NULL,
            status TEXT NOT NULL,
            last_synced_at TEXT,
            last_error TEXT,
            next_retry_at TEXT,
            FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
          );
          CREATE TABLE IF NOT EXISTS ticket_sync_operations (
            idempotency_key TEXT PRIMARY KEY,
            ticket_id TEXT NOT NULL,
            provider TEXT NOT NULL,
            operation TEXT NOT NULL,
            status TEXT NOT NULL,
            request_json TEXT NOT NULL,
            response_json TEXT,
            last_error TEXT,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
          );
          CREATE TABLE IF NOT EXISTS external_ticket_events (
            provider TEXT NOT NULL,
            provider_event_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            payload TEXT NOT NULL,
            status TEXT NOT NULL,
            last_error TEXT,
            received_at TEXT NOT NULL,
            PRIMARY KEY (provider, provider_event_id)
          );
          CREATE TABLE IF NOT EXISTS forgejo_instance_metadata (
            instance_url TEXT PRIMARY KEY,
            version TEXT NOT NULL,
            api_version TEXT,
            capabilities_json TEXT NOT NULL,
            last_checked_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS ticket_migrations (
            ticket_id TEXT PRIMARY KEY,
            target_provider TEXT NOT NULL CHECK (target_provider IN ('github', 'forgejo')),
            stage TEXT NOT NULL CHECK (
              stage IN ('prepared', 'remote_created', 'verified', 'completed')
            ),
            state_json TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
          );
          CREATE TABLE IF NOT EXISTS ticket_migration_history (
            ticket_id TEXT NOT NULL,
            stage TEXT NOT NULL CHECK (
              stage IN ('prepared', 'remote_created', 'verified', 'completed')
            ),
            state_json TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (ticket_id, stage),
            FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
          );
        `);
      },
      (error) => databaseError('initializeTicketSync', error),
    );
  }

  dispose(): void {
    this.database.close();
  }

  recordExternalEvent(event: ExternalTicketEvent): Result<boolean, TicketError> {
    return safeCall(
      () => {
        const result = this.database
          .query(
            `INSERT INTO external_ticket_events (
              provider, provider_event_id, event_type, payload, status, received_at
            ) VALUES (?, ?, ?, ?, 'received', ?)
            ON CONFLICT(provider, provider_event_id) DO NOTHING`,
          )
          .run(
            event.provider,
            event.providerEventId,
            event.eventType,
            event.payload,
            event.receivedAt,
          );
        return result.changes === 1;
      },
      (error) => databaseError('recordExternalEvent', error),
    );
  }

  completeExternalEvent(
    provider: string,
    providerEventId: string,
    error?: string,
  ): Result<void, TicketError> {
    return safeCall(
      () => {
        this.database
          .query(
            `UPDATE external_ticket_events
             SET status = ?, last_error = ?
             WHERE provider = ? AND provider_event_id = ?`,
          )
          .run(
            error === undefined ? 'completed' : 'failed',
            error ?? null,
            provider,
            providerEventId,
          );
      },
      (cause) => databaseError('completeExternalEvent', cause),
    );
  }

  getSyncState(ticketId: string): Result<TicketSyncState, TicketError> {
    return safeCall(
      () => {
        const row = this.database
          .query<SyncStateRow, [string]>(
            `SELECT ticket_id, provider, status, last_synced_at, last_error, next_retry_at
             FROM ticket_sync_state WHERE ticket_id = ?`,
          )
          .get(ticketId);
        const state: TicketSyncState = row
          ? {
              ticketId: row.ticket_id,
              provider: row.provider,
              status: row.status,
              ...(row.last_synced_at === null ? {} : { lastSyncedAt: row.last_synced_at }),
              ...(row.last_error === null ? {} : { lastError: row.last_error }),
              ...(row.next_retry_at === null ? {} : { nextRetryAt: row.next_retry_at }),
            }
          : {
              ticketId,
              provider: 'local',
              status: 'idle',
            };
        return state;
      },
      (error) => databaseError('getSyncState', error),
    );
  }

  setSyncState(state: TicketSyncState): Result<void, TicketError> {
    return safeCall(
      () => {
        this.database
          .query(
            `INSERT INTO ticket_sync_state (
              ticket_id, provider, status, last_synced_at, last_error, next_retry_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(ticket_id) DO UPDATE SET
              provider = excluded.provider,
              status = excluded.status,
              last_synced_at = excluded.last_synced_at,
              last_error = excluded.last_error,
              next_retry_at = excluded.next_retry_at`,
          )
          .run(
            state.ticketId,
            state.provider,
            state.status,
            state.lastSyncedAt ?? null,
            state.lastError ?? null,
            state.nextRetryAt ?? null,
          );
      },
      (error) => databaseError('setSyncState', error),
    );
  }

  saveForgejoMetadata(metadata: ForgejoInstanceMetadata): Result<void, TicketError> {
    return safeCall(
      () => {
        this.database
          .query(
            `INSERT INTO forgejo_instance_metadata (
              instance_url, version, api_version, capabilities_json, last_checked_at
            ) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(instance_url) DO UPDATE SET
              version = excluded.version,
              api_version = excluded.api_version,
              capabilities_json = excluded.capabilities_json,
              last_checked_at = excluded.last_checked_at`,
          )
          .run(
            metadata.instanceUrl,
            metadata.version,
            metadata.apiVersion ?? null,
            JSON.stringify(metadata.capabilities),
            metadata.lastCheckedAt,
          );
      },
      (error) => databaseError('saveForgejoMetadata', error),
    );
  }

  getForgejoMetadata(
    instanceUrl: string,
  ): Result<ForgejoInstanceMetadata | undefined, TicketError> {
    return safeCall(
      () => {
        const row = this.database
          .query<ForgejoMetadataRow, [string]>(
            `SELECT instance_url, version, api_version, capabilities_json, last_checked_at
             FROM forgejo_instance_metadata WHERE instance_url = ?`,
          )
          .get(instanceUrl);
        if (!row) return undefined;
        return {
          instanceUrl: row.instance_url,
          version: row.version,
          ...(row.api_version === null ? {} : { apiVersion: row.api_version }),
          capabilities: parseCapabilities(row.capabilities_json),
          lastCheckedAt: row.last_checked_at,
        };
      },
      (error) => databaseError('getForgejoMetadata', error),
    );
  }

  getMigration(ticketId: string): Result<TicketMigration | undefined, TicketError> {
    return safeCall(
      () => {
        const row = this.database
          .query<MigrationRow, [string]>(
            'SELECT state_json FROM ticket_migrations WHERE ticket_id = ?',
          )
          .get(ticketId);
        return row ? parseMigration(row.state_json) : undefined;
      },
      (error) => databaseError('getTicketMigration', error),
    );
  }

  saveMigration(migration: TicketMigration): Result<void, TicketError> {
    return safeCall(
      () => {
        const serialized = JSON.stringify(migration);
        this.database.transaction(() => {
          this.database
            .query(
              `INSERT INTO ticket_migrations (
                ticket_id, target_provider, stage, state_json, updated_at
              ) VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(ticket_id) DO UPDATE SET
                target_provider = excluded.target_provider,
                stage = excluded.stage,
                state_json = excluded.state_json,
                updated_at = excluded.updated_at`,
            )
            .run(
              migration.ticketId,
              migration.targetProvider,
              migration.stage,
              serialized,
              migration.updatedAt,
            );
          this.database
            .query(
              `INSERT INTO ticket_migration_history (
                ticket_id, stage, state_json, updated_at
              ) VALUES (?, ?, ?, ?)
              ON CONFLICT(ticket_id, stage) DO UPDATE SET
                state_json = excluded.state_json,
                updated_at = excluded.updated_at`,
            )
            .run(migration.ticketId, migration.stage, serialized, migration.updatedAt);
        })();
      },
      (error) => databaseError('saveTicketMigration', error),
    );
  }

  listSyncOperations(ticketId: string): Result<readonly TicketSyncOperation[], TicketError> {
    return safeCall(
      () =>
        this.database
          .query<SyncOperationRow, [string]>(
            `SELECT idempotency_key, ticket_id, provider, operation, status,
                    last_error, updated_at
             FROM ticket_sync_operations
             WHERE ticket_id = ?
             ORDER BY updated_at, idempotency_key`,
          )
          .all(ticketId)
          .map((row) => ({
            idempotencyKey: row.idempotency_key,
            ticketId: row.ticket_id,
            provider: row.provider,
            operation: row.operation,
            status: row.status,
            ...(row.last_error === null ? {} : { error: row.last_error }),
            updatedAt: row.updated_at,
          })),
      (error) => databaseError('listTicketSyncOperations', error),
    );
  }

  listMigrationHistory(ticketId: string): Result<readonly TicketMigration[], TicketError> {
    return safeCall(
      () =>
        this.database
          .query<MigrationRow, [string]>(
            `SELECT state_json
             FROM ticket_migration_history
             WHERE ticket_id = ?
             ORDER BY
               CASE stage
                 WHEN 'prepared' THEN 1
                 WHEN 'remote_created' THEN 2
                 WHEN 'verified' THEN 3
                 WHEN 'completed' THEN 4
               END`,
          )
          .all(ticketId)
          .map((row) => parseMigration(row.state_json)),
      (error) => databaseError('listTicketMigrationHistory', error),
    );
  }

  recordSyncOperation(input: {
    readonly idempotencyKey: string;
    readonly ticketId: string;
    readonly provider: string;
    readonly operation: string;
    readonly status: 'pending' | 'succeeded' | 'failed';
    readonly request: string;
    readonly response?: string;
    readonly error?: string;
    readonly updatedAt: string;
  }): Result<boolean, TicketError> {
    return safeCall(
      () => {
        const existing = this.database
          .query<{ readonly request_json: string; readonly status: string }, [string]>(
            `SELECT request_json, status FROM ticket_sync_operations
             WHERE idempotency_key = ?`,
          )
          .get(input.idempotencyKey);
        if (existing) {
          if (existing.request_json !== input.request) {
            return false;
          }
          if (existing.status === 'succeeded') return false;
          this.database
            .query(
              `UPDATE ticket_sync_operations
               SET status = ?, response_json = ?, last_error = ?, updated_at = ?
               WHERE idempotency_key = ?`,
            )
            .run(
              input.status,
              input.response ?? null,
              input.error ?? null,
              input.updatedAt,
              input.idempotencyKey,
            );
          return true;
        }
        this.database
          .query(
            `INSERT INTO ticket_sync_operations (
              idempotency_key, ticket_id, provider, operation, status,
              request_json, response_json, last_error, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            input.idempotencyKey,
            input.ticketId,
            input.provider,
            input.operation,
            input.status,
            input.request,
            input.response ?? null,
            input.error ?? null,
            input.updatedAt,
          );
        return true;
      },
      (error) => databaseError('recordSyncOperation', error),
    );
  }
}
