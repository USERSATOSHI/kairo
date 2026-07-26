import { Database } from 'bun:sqlite';

import { ok, safeCall, type Result } from '@usersatoshi/results';

import type { TicketRepository } from '../application/ports.ts';
import type {
  Ticket,
  TicketBinding,
  TicketComment,
  TicketCommentBinding,
  TicketPriority,
  TicketRelationship,
  TicketRelationshipKind,
  TicketStatus,
  UpdateTicketInput,
} from '../domain/types.ts';
import { TicketErrorKind, toErr, toTicketError, type TicketError } from '../errors.ts';

interface TicketRow {
  readonly id: string;
  readonly project_id: string;
  readonly title: string;
  readonly description: string;
  readonly status: TicketStatus;
  readonly priority: TicketPriority | null;
  readonly revision: number;
  readonly created_at: string;
  readonly updated_at: string;
}

interface BindingRow {
  readonly provider: TicketBinding['kind'];
  readonly instance_url: string | null;
  readonly owner: string | null;
  readonly repository: string | null;
  readonly issue_number: number | null;
  readonly external_url: string | null;
  readonly last_synced_revision: string | null;
}

interface ValueRow {
  readonly value: string;
}

interface CommentRow {
  readonly id: string;
  readonly ticket_id: string;
  readonly author: string;
  readonly body: string;
  readonly binding_json: string;
  readonly created_at: string;
  readonly updated_at: string | null;
}

interface RelationshipRow {
  readonly source_ticket_id: string;
  readonly target_ticket_id: string;
  readonly kind: TicketRelationshipKind;
}

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : 'SQLite ticket operation failed';
}

function databaseError(operation: string, error: unknown): TicketError {
  return toErr(TicketErrorKind.DatabaseFailure, {
    operation,
    message: messageFor(error),
  });
}

function bindingFromRow(row: BindingRow): TicketBinding {
  if (row.provider === 'local') return { kind: 'local' };
  if (
    row.owner === null ||
    row.repository === null ||
    row.issue_number === null ||
    row.external_url === null
  ) {
    throw new Error('Provider ticket binding is incomplete');
  }
  if (row.provider === 'github') {
    return {
      kind: 'github',
      owner: row.owner,
      repository: row.repository,
      issueNumber: row.issue_number,
      externalUrl: row.external_url,
      ...(row.last_synced_revision === null
        ? {}
        : { lastSyncedRevision: row.last_synced_revision }),
    };
  }
  if (row.instance_url === null) {
    throw new Error('Forgejo ticket binding is missing its instance URL');
  }
  return {
    kind: 'forgejo',
    instanceUrl: row.instance_url,
    owner: row.owner,
    repository: row.repository,
    issueNumber: row.issue_number,
    externalUrl: row.external_url,
    ...(row.last_synced_revision === null ? {} : { lastSyncedRevision: row.last_synced_revision }),
  };
}

function commentBinding(serialized: string): TicketCommentBinding {
  const parsed: unknown = JSON.parse(serialized);
  if (parsed !== null && typeof parsed === 'object' && 'kind' in parsed) {
    const kind = parsed.kind;
    if (kind === 'local') return { kind };
    if (
      (kind === 'github' || kind === 'forgejo') &&
      'externalId' in parsed &&
      typeof parsed.externalId === 'string'
    ) {
      return { kind, externalId: parsed.externalId };
    }
  }
  throw new Error('Ticket comment binding is malformed');
}

/**
 * SQLite-backed local ticket repository. Each aggregate mutation is atomic.
 */
export class SqliteTicketRepository implements TicketRepository {
  private readonly database: Database;

  constructor(path: string) {
    this.database = new Database(path, {
      create: true,
      strict: true,
    });
  }

  initialize(): Result<void, TicketError> {
    return safeCall(
      () => {
        this.database.exec('PRAGMA foreign_keys = ON');
        this.database.exec('PRAGMA journal_mode = WAL');
        this.database.exec(`
          CREATE TABLE IF NOT EXISTS tickets (
            id TEXT PRIMARY KEY,
            project_id TEXT NOT NULL,
            title TEXT NOT NULL,
            description TEXT NOT NULL,
            status TEXT NOT NULL CHECK (
              status IN ('backlog', 'ready', 'blocked', 'done', 'cancelled')
            ),
            priority TEXT CHECK (
              priority IS NULL OR priority IN ('low', 'medium', 'high', 'critical')
            ),
            revision INTEGER NOT NULL CHECK (revision >= 1),
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS tickets_project_updated
            ON tickets(project_id, updated_at DESC, id);

          CREATE TABLE IF NOT EXISTS ticket_bindings (
            ticket_id TEXT PRIMARY KEY,
            provider TEXT NOT NULL CHECK (provider IN ('local', 'github', 'forgejo')),
            instance_url TEXT,
            owner TEXT,
            repository TEXT,
            issue_number INTEGER,
            external_url TEXT,
            last_synced_revision TEXT,
            FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
          );
          CREATE UNIQUE INDEX IF NOT EXISTS ticket_external_binding
            ON ticket_bindings(
              provider,
              COALESCE(instance_url, ''),
              COALESCE(owner, ''),
              COALESCE(repository, ''),
              issue_number
            )
            WHERE provider <> 'local';

          CREATE TABLE IF NOT EXISTS ticket_comments (
            id TEXT PRIMARY KEY,
            ticket_id TEXT NOT NULL,
            author TEXT NOT NULL,
            body TEXT NOT NULL,
            binding_json TEXT NOT NULL,
            created_at TEXT NOT NULL,
            updated_at TEXT,
            FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
          );
          CREATE INDEX IF NOT EXISTS ticket_comments_ticket_created
            ON ticket_comments(ticket_id, created_at, id);

          CREATE TABLE IF NOT EXISTS ticket_labels (
            ticket_id TEXT NOT NULL,
            label TEXT NOT NULL,
            PRIMARY KEY (ticket_id, label),
            FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
          );

          CREATE TABLE IF NOT EXISTS ticket_assignees (
            ticket_id TEXT NOT NULL,
            assignee TEXT NOT NULL,
            PRIMARY KEY (ticket_id, assignee),
            FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
          );

          CREATE TABLE IF NOT EXISTS ticket_relationships (
            source_ticket_id TEXT NOT NULL,
            target_ticket_id TEXT NOT NULL,
            kind TEXT NOT NULL CHECK (
              kind IN ('blocks', 'blocked_by', 'parent', 'child', 'related')
            ),
            PRIMARY KEY (source_ticket_id, target_ticket_id, kind),
            CHECK (source_ticket_id <> target_ticket_id),
            FOREIGN KEY (source_ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
            FOREIGN KEY (target_ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
          );

          CREATE TABLE IF NOT EXISTS kanban_planning_state (
            ticket_id TEXT PRIMARY KEY,
            status TEXT NOT NULL CHECK (
              status IN ('backlog', 'ready', 'blocked', 'done', 'cancelled')
            ),
            updated_at TEXT NOT NULL,
            FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
          );
        `);
      },
      (error) => databaseError('initialize', error),
    );
  }

  dispose(): void {
    this.database.close();
  }

  create(ticket: Ticket): Result<Ticket, TicketError> {
    return this.executeTransaction('create', () => {
      if (this.readTicketRow(ticket.id)) {
        return toTicketError(TicketErrorKind.AlreadyExists, { ticketId: ticket.id });
      }
      this.database
        .query(
          `INSERT INTO tickets (
            id, project_id, title, description, status, priority,
            revision, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          ticket.id,
          ticket.projectId,
          ticket.title,
          ticket.description,
          ticket.status,
          ticket.priority ?? null,
          ticket.revision,
          ticket.createdAt,
          ticket.updatedAt,
        );
      this.insertBinding(ticket.id, ticket.binding);
      this.replaceValues('ticket_labels', 'label', ticket.id, ticket.labels);
      this.replaceValues('ticket_assignees', 'assignee', ticket.id, ticket.assignees);
      this.database
        .query(
          `INSERT INTO kanban_planning_state (ticket_id, status, updated_at)
           VALUES (?, ?, ?)`,
        )
        .run(ticket.id, ticket.status, ticket.updatedAt);
      return ok(ticket);
    });
  }

  get(ticketId: string): Result<Ticket, TicketError> {
    const loaded = safeCall(
      () => this.loadTicketUnsafe(ticketId),
      (error) => databaseError('get', error),
    );
    return loaded.isErr() ? loaded : loaded.unwrap();
  }

  list(projectId: string): Result<readonly Ticket[], TicketError> {
    const loaded = safeCall(
      () =>
        this.database
          .query<{ readonly id: string }, [string]>(
            `SELECT id FROM tickets
             WHERE project_id = ?
             ORDER BY updated_at DESC, id`,
          )
          .all(projectId)
          .map(({ id }) => this.loadTicketUnsafe(id)),
      (error) => databaseError('list', error),
    );
    if (loaded.isErr()) return loaded;
    const tickets: Ticket[] = [];
    for (const result of loaded.unwrap()) {
      if (result.isErr()) return result;
      tickets.push(result.unwrap());
    }
    return ok(tickets);
  }

  update(
    ticketId: string,
    input: UpdateTicketInput,
    updatedAt: string,
  ): Result<Ticket, TicketError> {
    return this.executeTransaction('update', () => {
      const current = this.loadTicketUnsafe(ticketId);
      if (current.isErr()) return current;
      const ticket = current.unwrap();
      if (ticket.revision !== input.expectedRevision) {
        return toTicketError(TicketErrorKind.RevisionConflict, {
          ticketId,
          expected: input.expectedRevision,
          actual: ticket.revision,
        });
      }
      const nextPriority =
        input.priority === undefined
          ? ticket.priority
          : input.priority === null
            ? undefined
            : input.priority;
      this.database
        .query(
          `UPDATE tickets
           SET title = ?, description = ?, priority = ?, revision = ?, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(
          input.title ?? ticket.title,
          input.description ?? ticket.description,
          nextPriority ?? null,
          ticket.revision + 1,
          updatedAt,
          ticketId,
          ticket.revision,
        );
      if (input.labels !== undefined) {
        this.replaceValues('ticket_labels', 'label', ticketId, input.labels);
      }
      if (input.assignees !== undefined) {
        this.replaceValues('ticket_assignees', 'assignee', ticketId, input.assignees);
      }
      return this.loadTicketUnsafe(ticketId);
    });
  }

  setStatus(
    ticketId: string,
    expectedRevision: number,
    status: TicketStatus,
    updatedAt: string,
  ): Result<Ticket, TicketError> {
    return this.executeTransaction('setStatus', () => {
      const current = this.loadTicketUnsafe(ticketId);
      if (current.isErr()) return current;
      const ticket = current.unwrap();
      if (ticket.revision !== expectedRevision) {
        return toTicketError(TicketErrorKind.RevisionConflict, {
          ticketId,
          expected: expectedRevision,
          actual: ticket.revision,
        });
      }
      this.database
        .query(
          `UPDATE tickets
           SET status = ?, revision = ?, updated_at = ?
           WHERE id = ? AND revision = ?`,
        )
        .run(status, ticket.revision + 1, updatedAt, ticketId, ticket.revision);
      this.database
        .query(
          `UPDATE kanban_planning_state SET status = ?, updated_at = ?
           WHERE ticket_id = ?`,
        )
        .run(status, updatedAt, ticketId);
      return this.loadTicketUnsafe(ticketId);
    });
  }

  addComment(comment: TicketComment, updatedAt: string): Result<TicketComment, TicketError> {
    return this.executeTransaction('addComment', () => {
      const ticket = this.loadTicketUnsafe(comment.ticketId);
      if (ticket.isErr()) return ticket;
      this.database
        .query(
          `INSERT INTO ticket_comments (
            id, ticket_id, author, body, binding_json, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          comment.id,
          comment.ticketId,
          comment.author,
          comment.body,
          JSON.stringify(comment.binding),
          comment.createdAt,
          comment.updatedAt ?? null,
        );
      this.database
        .query('UPDATE tickets SET revision = revision + 1, updated_at = ? WHERE id = ?')
        .run(updatedAt, comment.ticketId);
      return ok(comment);
    });
  }

  listComments(ticketId: string): Result<readonly TicketComment[], TicketError> {
    const loaded = safeCall(
      () => {
        const ticket = this.loadTicketUnsafe(ticketId);
        if (ticket.isErr()) return ticket;
        return ok(
          this.database
            .query<CommentRow, [string]>(
              `SELECT id, ticket_id, author, body, binding_json, created_at, updated_at
               FROM ticket_comments
               WHERE ticket_id = ?
               ORDER BY created_at, id`,
            )
            .all(ticketId)
            .map((row) => ({
              id: row.id,
              ticketId: row.ticket_id,
              author: row.author,
              body: row.body,
              binding: commentBinding(row.binding_json),
              createdAt: row.created_at,
              ...(row.updated_at === null ? {} : { updatedAt: row.updated_at }),
            })),
        );
      },
      (error) => databaseError('listComments', error),
    );
    return loaded.isErr() ? loaded : loaded.unwrap();
  }

  addRelationship(relationship: TicketRelationship): Result<TicketRelationship, TicketError> {
    return this.executeTransaction('addRelationship', () => {
      const source = this.loadTicketUnsafe(relationship.sourceTicketId);
      if (source.isErr()) return source;
      const target = this.loadTicketUnsafe(relationship.targetTicketId);
      if (target.isErr()) return target;
      const existing = this.database
        .query<RelationshipRow, [string, string, TicketRelationshipKind]>(
          `SELECT source_ticket_id, target_ticket_id, kind
           FROM ticket_relationships
           WHERE source_ticket_id = ? AND target_ticket_id = ? AND kind = ?`,
        )
        .get(relationship.sourceTicketId, relationship.targetTicketId, relationship.kind);
      if (existing) {
        return toTicketError(TicketErrorKind.RelationshipConflict, {
          sourceTicketId: relationship.sourceTicketId,
          targetTicketId: relationship.targetTicketId,
          reason: 'relationship already exists',
        });
      }
      this.database
        .query(
          `INSERT INTO ticket_relationships (
            source_ticket_id, target_ticket_id, kind
          ) VALUES (?, ?, ?)`,
        )
        .run(relationship.sourceTicketId, relationship.targetTicketId, relationship.kind);
      return ok(relationship);
    });
  }

  listRelationships(ticketId: string): Result<readonly TicketRelationship[], TicketError> {
    const loaded = safeCall(
      () => {
        const ticket = this.loadTicketUnsafe(ticketId);
        if (ticket.isErr()) return ticket;
        return ok(
          this.database
            .query<RelationshipRow, [string, string]>(
              `SELECT source_ticket_id, target_ticket_id, kind
               FROM ticket_relationships
               WHERE source_ticket_id = ? OR target_ticket_id = ?
               ORDER BY source_ticket_id, target_ticket_id, kind`,
            )
            .all(ticketId, ticketId)
            .map((row) => ({
              sourceTicketId: row.source_ticket_id,
              targetTicketId: row.target_ticket_id,
              kind: row.kind,
            })),
        );
      },
      (error) => databaseError('listRelationships', error),
    );
    return loaded.isErr() ? loaded : loaded.unwrap();
  }

  private executeTransaction<T>(
    operation: string,
    callback: () => Result<T, TicketError>,
  ): Result<T, TicketError> {
    const transaction = this.database.transaction(callback);
    const executed = safeCall(
      () => transaction(),
      (error) => databaseError(operation, error),
    );
    return executed.isErr() ? executed : executed.unwrap();
  }

  private readTicketRow(ticketId: string): TicketRow | null {
    return this.database
      .query<TicketRow, [string]>(
        `SELECT id, project_id, title, description, status, priority,
                revision, created_at, updated_at
         FROM tickets
         WHERE id = ?`,
      )
      .get(ticketId);
  }

  private loadTicketUnsafe(ticketId: string): Result<Ticket, TicketError> {
    const row = this.readTicketRow(ticketId);
    if (!row) return toTicketError(TicketErrorKind.NotFound, { ticketId });
    const binding = this.database
      .query<BindingRow, [string]>(
        `SELECT provider, instance_url, owner, repository, issue_number,
                external_url, last_synced_revision
         FROM ticket_bindings
         WHERE ticket_id = ?`,
      )
      .get(ticketId);
    if (!binding) throw new Error(`Ticket ${ticketId} has no binding`);
    const labels = this.readValues('ticket_labels', 'label', ticketId);
    const assignees = this.readValues('ticket_assignees', 'assignee', ticketId);
    return ok({
      id: row.id,
      projectId: row.project_id,
      title: row.title,
      description: row.description,
      status: row.status,
      ...(row.priority === null ? {} : { priority: row.priority }),
      labels,
      assignees,
      binding: bindingFromRow(binding),
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  private insertBinding(ticketId: string, binding: TicketBinding): void {
    this.database
      .query(
        `INSERT INTO ticket_bindings (
          ticket_id, provider, instance_url, owner, repository, issue_number,
          external_url, last_synced_revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        ticketId,
        binding.kind,
        binding.kind === 'forgejo' ? binding.instanceUrl : null,
        binding.kind === 'local' ? null : binding.owner,
        binding.kind === 'local' ? null : binding.repository,
        binding.kind === 'local' ? null : binding.issueNumber,
        binding.kind === 'local' ? null : binding.externalUrl,
        binding.kind === 'local' ? null : (binding.lastSyncedRevision ?? null),
      );
  }

  private readValues(table: string, column: string, ticketId: string): readonly string[] {
    return this.database
      .query<ValueRow, [string]>(
        `SELECT ${column} AS value FROM ${table} WHERE ticket_id = ? ORDER BY ${column}`,
      )
      .all(ticketId)
      .map(({ value }) => value);
  }

  private replaceValues(
    table: string,
    column: string,
    ticketId: string,
    values: readonly string[],
  ): void {
    this.database.query(`DELETE FROM ${table} WHERE ticket_id = ?`).run(ticketId);
    const insert = this.database.query(`INSERT INTO ${table} (ticket_id, ${column}) VALUES (?, ?)`);
    for (const value of values) insert.run(ticketId, value);
  }
}
