import { Database } from 'bun:sqlite';

import { err, ok, safeCall, type Result } from '@usersatoshi/results';

import type { TicketError } from '../errors.ts';
import { TicketErrorKind, toErr } from '../errors.ts';
import type { TicketRunStore } from '../integration/ports.ts';
import type { TicketRunLink, TicketRunLinkKind, TicketSnapshot } from '../integration/types.ts';

interface SnapshotRow {
  readonly id: string;
  readonly run_id: string;
  readonly ticket_id: string;
  readonly project_id: string;
  readonly title: string;
  readonly description: string;
  readonly priority: TicketSnapshot['priority'] | null;
  readonly labels_json: string;
  readonly assignees_json: string;
  readonly provider: TicketSnapshot['provider'];
  readonly provider_revision: string;
  readonly captured_at: string;
}

interface RunLinkRow {
  readonly ticket_id: string;
  readonly run_id: string;
  readonly kind: TicketRunLinkKind;
  readonly created_at: string;
}

function databaseError(operation: string, error: unknown): TicketError {
  return toErr(TicketErrorKind.DatabaseFailure, {
    operation,
    message: error instanceof Error ? error.message : 'SQLite ticket-run operation failed',
  });
}

function stringArray(serialized: string, entity: string): Result<readonly string[], TicketError> {
  const decoded = safeCall(
    (): unknown => JSON.parse(serialized),
    () =>
      toErr(TicketErrorKind.CorruptData, {
        entity,
        reason: 'value is not valid JSON',
      }),
  );
  if (decoded.isErr()) return decoded;
  const parsed = decoded.unwrap();
  if (!Array.isArray(parsed) || !parsed.every((value) => typeof value === 'string')) {
    return err(
      toErr(TicketErrorKind.CorruptData, {
        entity,
        reason: 'value is not a string array',
      }),
    );
  }
  return ok(parsed);
}

export class SqliteTicketRunStore implements TicketRunStore {
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
          CREATE TABLE IF NOT EXISTS ticket_snapshots (
            id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL UNIQUE,
            ticket_id TEXT NOT NULL,
            project_id TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            priority TEXT,
            labels_json TEXT NOT NULL,
            assignees_json TEXT NOT NULL,
            provider TEXT NOT NULL,
            provider_revision TEXT NOT NULL,
            captured_at TEXT NOT NULL,
            FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE RESTRICT
          );
          CREATE INDEX IF NOT EXISTS ticket_snapshots_ticket
            ON ticket_snapshots(ticket_id, captured_at, id);

          CREATE TABLE IF NOT EXISTS ticket_run_links (
            ticket_id TEXT NOT NULL,
            run_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (
              kind IN ('planning', 'implementation', 'review', 'remediation')
            ),
            created_at TEXT NOT NULL,
            PRIMARY KEY (ticket_id, run_id),
            FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE RESTRICT
          );
          CREATE INDEX IF NOT EXISTS ticket_run_links_ticket_created
            ON ticket_run_links(ticket_id, created_at, run_id);
        `);
      },
      (error) => databaseError('initializeTicketRuns', error),
    );
  }

  dispose(): void {
    this.database.close();
  }

  recordRunStart(snapshot: TicketSnapshot, link: TicketRunLink): Result<void, TicketError> {
    const transaction = this.database.transaction(() => {
      this.database
        .query(
          `INSERT INTO ticket_snapshots (
            id, run_id, ticket_id, project_id, title, description, priority,
            labels_json, assignees_json, provider, provider_revision, captured_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(run_id) DO NOTHING`,
        )
        .run(
          snapshot.id,
          snapshot.runId,
          snapshot.ticketId,
          snapshot.projectId,
          snapshot.title,
          snapshot.description,
          snapshot.priority ?? null,
          JSON.stringify(snapshot.labels),
          JSON.stringify(snapshot.assignees),
          snapshot.provider,
          snapshot.providerRevision,
          snapshot.capturedAt,
        );
      this.database
        .query(
          `INSERT INTO ticket_run_links (ticket_id, run_id, kind, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(ticket_id, run_id) DO NOTHING`,
        )
        .run(link.ticketId, link.runId, link.kind, link.createdAt);
    });
    return safeCall(
      () => transaction(),
      (error) => databaseError('recordRunStart', error),
    );
  }

  listSnapshots(ticketId: string): Result<readonly TicketSnapshot[], TicketError> {
    const loaded = safeCall(
      () => {
        const snapshots: TicketSnapshot[] = [];
        const rows = this.database
          .query<SnapshotRow, [string]>(
            `SELECT id, run_id, ticket_id, project_id, title, description, priority,
                    labels_json, assignees_json, provider, provider_revision, captured_at
             FROM ticket_snapshots
             WHERE ticket_id = ?
             ORDER BY captured_at, id`,
          )
          .all(ticketId);
        for (const row of rows) {
          const labels = stringArray(row.labels_json, `ticket_snapshot:${row.id}:labels`);
          if (labels.isErr()) return labels;
          const assignees = stringArray(row.assignees_json, `ticket_snapshot:${row.id}:assignees`);
          if (assignees.isErr()) return assignees;
          snapshots.push({
            id: row.id,
            runId: row.run_id,
            ticketId: row.ticket_id,
            projectId: row.project_id,
            title: row.title,
            description: row.description,
            ...(row.priority === null ? {} : { priority: row.priority }),
            labels: labels.unwrap(),
            assignees: assignees.unwrap(),
            provider: row.provider,
            providerRevision: row.provider_revision,
            capturedAt: row.captured_at,
          });
        }
        return ok(snapshots);
      },
      (error) => databaseError('listSnapshots', error),
    );
    return loaded.isErr() ? loaded : loaded.unwrap();
  }

  listRunLinks(ticketId: string): Result<readonly TicketRunLink[], TicketError> {
    return safeCall(
      () =>
        this.database
          .query<RunLinkRow, [string]>(
            `SELECT ticket_id, run_id, kind, created_at
             FROM ticket_run_links
             WHERE ticket_id = ?
             ORDER BY created_at, run_id`,
          )
          .all(ticketId)
          .map((row) => ({
            ticketId: row.ticket_id,
            runId: row.run_id,
            kind: row.kind,
            createdAt: row.created_at,
          })),
      (error) => databaseError('listRunLinks', error),
    );
  }
}
