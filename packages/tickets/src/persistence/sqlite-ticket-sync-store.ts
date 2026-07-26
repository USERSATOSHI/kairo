import { Database } from 'bun:sqlite';

import { safeCall, type Result } from '@usersatoshi/results';

import type { TicketError } from '../errors.ts';
import { TicketErrorKind, toErr } from '../errors.ts';
import type { TicketSyncStore } from '../integration/ports.ts';
import type { ExternalTicketEvent, TicketSyncState } from '../integration/types.ts';

interface SyncStateRow {
  readonly ticket_id: string;
  readonly provider: TicketSyncState['provider'];
  readonly status: TicketSyncState['status'];
  readonly last_synced_at: string | null;
  readonly last_error: string | null;
  readonly next_retry_at: string | null;
}

function databaseError(operation: string, error: unknown): TicketError {
  return toErr(TicketErrorKind.DatabaseFailure, {
    operation,
    message: error instanceof Error ? error.message : 'SQLite ticket-sync operation failed',
  });
}

export class SqliteTicketSyncStore implements TicketSyncStore {
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
