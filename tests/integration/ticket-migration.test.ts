import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import {
  SqliteTicketRepository,
  SqliteTicketSyncStore,
  TicketErrorKind,
  TicketMigrationErrorKind,
  TicketMigrationService,
  TicketService,
  TicketProviderErrorKind,
  toTicketError,
  type AddTicketCommentInput,
  type ProjectId,
  type ProviderComment,
  type ProviderCreateTicketInput,
  type ProviderTicket,
  type ProviderUpdateTicketInput,
  type Ticket,
  type TicketBinding,
  type TicketClock,
  type TicketIdGenerator,
  type TicketMigration,
  type TicketMigrationStore,
  type TicketProvider,
  type TicketProviderError,
} from '@kairo/tickets';
import { err, ok, type Result } from '@usersatoshi/results';

type RemoteKind = 'github' | 'forgejo';

class Clock implements TicketClock {
  now(): string {
    return '2026-07-26T18:00:00.000Z';
  }
}

class Ids implements TicketIdGenerator {
  ticketId(): string {
    return 'ticket-1';
  }

  commentId(): string {
    return 'comment-1';
  }
}

function remoteBinding(kind: RemoteKind): TicketBinding {
  return kind === 'github'
    ? {
        kind,
        owner: 'acme',
        repository: 'kairo',
        issueNumber: 41,
        externalUrl: 'https://github.test/acme/kairo/issues/41',
        lastSyncedRevision: 'remote-1',
      }
    : {
        kind,
        instanceUrl: 'https://forgejo.test',
        owner: 'acme',
        repository: 'kairo',
        issueNumber: 41,
        externalUrl: 'https://forgejo.test/acme/kairo/issues/41',
        lastSyncedRevision: 'remote-1',
      };
}

function unavailable(message: string): Result<never, TicketProviderError> {
  return err({
    kind: TicketProviderErrorKind.Unavailable,
    code: 'test_unavailable',
    message,
  });
}

class MigrationProvider implements TicketProvider {
  remote?: ProviderTicket;
  createCalls = 0;
  failNextGet = false;
  tamperReadBack = false;

  constructor(readonly kind: RemoteKind) {}

  async get(binding: TicketBinding): Promise<Result<ProviderTicket, TicketProviderError>> {
    if (this.failNextGet) {
      this.failNextGet = false;
      return unavailable('interrupted before verification');
    }
    if (!this.remote || !sameBinding(binding, this.remote.binding)) {
      return err({
        kind: TicketProviderErrorKind.NotFound,
        code: 'test_not_found',
        message: 'Remote ticket was not found',
      });
    }
    return ok(
      this.tamperReadBack
        ? {
            ...this.remote,
            title: 'Changed during migration',
          }
        : this.remote,
    );
  }

  async list(
    projectId: ProjectId,
  ): Promise<Result<readonly ProviderTicket[], TicketProviderError>> {
    return projectId === 'project-1' && this.remote ? ok([this.remote]) : ok([]);
  }

  async create(
    projectId: ProjectId,
    input: ProviderCreateTicketInput,
  ): Promise<Result<ProviderTicket, TicketProviderError>> {
    this.createCalls += 1;
    this.remote = {
      binding: remoteBinding(this.kind),
      title: input.title,
      description: input.description,
      ...(input.marker === undefined ? {} : { marker: input.marker }),
      status: 'backlog',
      labels: input.labels ?? [],
      assignees: input.assignees ?? [],
      revision: 'remote-1',
      updatedAt: '2026-07-26T18:00:00.000Z',
    };
    return projectId === 'project-1'
      ? ok(this.remote)
      : unavailable('project does not belong to provider');
  }

  async update(
    _binding: TicketBinding,
    _input: ProviderUpdateTicketInput,
  ): Promise<Result<ProviderTicket, TicketProviderError>> {
    return this.remote ? ok(this.remote) : unavailable('remote ticket does not exist');
  }

  async addComment(
    _binding: TicketBinding,
    input: AddTicketCommentInput,
  ): Promise<Result<ProviderComment, TicketProviderError>> {
    return ok({
      externalId: 'comment-1',
      author: input.author,
      body: input.body,
      createdAt: '2026-07-26T18:00:00.000Z',
    });
  }

  async close(_binding: TicketBinding): Promise<Result<void, TicketProviderError>> {
    if (!this.remote) return unavailable('remote ticket does not exist');
    this.remote = { ...this.remote, status: 'done', revision: 'remote-2' };
    return ok(undefined);
  }

  async reopen(_binding: TicketBinding): Promise<Result<void, TicketProviderError>> {
    if (!this.remote) return unavailable('remote ticket does not exist');
    this.remote = { ...this.remote, status: 'backlog', revision: 'remote-2' };
    return ok(undefined);
  }
}

class FailAfterRemoteCreateStore implements TicketMigrationStore {
  private shouldFail = true;

  constructor(private readonly store: TicketMigrationStore) {}

  getMigration(
    ticketId: string,
  ): Result<TicketMigration | undefined, import('@kairo/tickets').TicketError> {
    return this.store.getMigration(ticketId);
  }

  saveMigration(migration: TicketMigration): Result<void, import('@kairo/tickets').TicketError> {
    if (this.shouldFail && migration.stage === 'remote_created') {
      this.shouldFail = false;
      return toTicketError(TicketErrorKind.DatabaseFailure, {
        operation: 'saveTicketMigration',
        message: 'simulated interruption after remote create',
      });
    }
    return this.store.saveMigration(migration);
  }
}

function sameBinding(left: TicketBinding, right: TicketBinding): boolean {
  if (left.kind === 'local' || right.kind === 'local' || left.kind !== right.kind) return false;
  return (
    left.owner === right.owner &&
    left.repository === right.repository &&
    left.issueNumber === right.issueNumber
  );
}

function createLocalTicket(repository: SqliteTicketRepository): Ticket {
  const service = new TicketService(repository, new Clock(), new Ids());
  return service
    .create({
      projectId: 'project-1',
      title: 'Migrate this ticket',
      description: 'Preserve this exact objective.',
      labels: ['migration', 'ticket'],
      assignees: ['satoshi'],
    })
    .unwrap();
}

describe('T5 ticket migration', () => {
  for (const kind of ['github', 'forgejo'] as const) {
    test(`migrates local authority to ${kind} only after verified read-back`, async () => {
      const directory = mkdtempSync(join(tmpdir(), `kairo-ticket-migration-${kind}-`));
      const path = join(directory, 'kairo.sqlite');
      const tickets = new SqliteTicketRepository(path);
      const migrations = new SqliteTicketSyncStore(path);
      const provider = new MigrationProvider(kind);
      try {
        expect(tickets.initialize().isOk()).toBe(true);
        expect(migrations.initialize().isOk()).toBe(true);
        createLocalTicket(tickets);
        const service = new TicketMigrationService(tickets, migrations, new Clock());

        const migrated = await service.migrate('ticket-1', 'project-1', provider);
        expect(migrated.unwrap().binding).toMatchObject({
          kind,
          issueNumber: 41,
          lastSyncedRevision: 'remote-1',
        });
        expect(migrations.getMigration('ticket-1').unwrap()).toMatchObject({
          targetProvider: kind,
          stage: 'completed',
        });

        expect((await service.migrate('ticket-1', 'project-1', provider)).isOk()).toBe(true);
        expect(provider.createCalls).toBe(1);
      } finally {
        migrations.dispose();
        tickets.dispose();
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }

  test('keeps local authority when remote verification fails', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kairo-ticket-migration-verification-'));
    const path = join(directory, 'kairo.sqlite');
    const tickets = new SqliteTicketRepository(path);
    const migrations = new SqliteTicketSyncStore(path);
    const provider = new MigrationProvider('github');
    provider.tamperReadBack = true;
    try {
      expect(tickets.initialize().isOk()).toBe(true);
      expect(migrations.initialize().isOk()).toBe(true);
      createLocalTicket(tickets);
      const service = new TicketMigrationService(tickets, migrations, new Clock());

      const migrated = await service.migrate('ticket-1', 'project-1', provider);
      expect(migrated.error?.kind).toBe(TicketMigrationErrorKind.VerificationFailed);
      expect(tickets.get('ticket-1').unwrap().binding).toEqual({ kind: 'local' });
      expect(migrations.getMigration('ticket-1').unwrap()?.stage).toBe('remote_created');

      const ticketService = new TicketService(tickets, new Clock(), new Ids());
      expect(
        ticketService
          .update('ticket-1', {
            expectedRevision: 1,
            title: 'Changed locally during migration',
          })
          .isOk(),
      ).toBe(true);
      provider.tamperReadBack = false;
      const conflicted = await service.migrate('ticket-1', 'project-1', provider);
      expect(conflicted.error?.kind).toBe(TicketMigrationErrorKind.Conflict);
      expect(tickets.get('ticket-1').unwrap().binding).toEqual({ kind: 'local' });
      expect(provider.createCalls).toBe(1);
    } finally {
      migrations.dispose();
      tickets.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('resumes after restart without creating a duplicate remote issue', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kairo-ticket-migration-resume-'));
    const path = join(directory, 'kairo.sqlite');
    const provider = new MigrationProvider('forgejo');
    let tickets = new SqliteTicketRepository(path);
    let migrations = new SqliteTicketSyncStore(path);
    try {
      expect(tickets.initialize().isOk()).toBe(true);
      expect(migrations.initialize().isOk()).toBe(true);
      createLocalTicket(tickets);
      const interrupted = new TicketMigrationService(
        tickets,
        new FailAfterRemoteCreateStore(migrations),
        new Clock(),
      );
      expect((await interrupted.migrate('ticket-1', 'project-1', provider)).isErr()).toBe(true);
      expect(provider.createCalls).toBe(1);
      expect(migrations.getMigration('ticket-1').unwrap()?.stage).toBe('prepared');

      migrations.dispose();
      tickets.dispose();
      tickets = new SqliteTicketRepository(path);
      migrations = new SqliteTicketSyncStore(path);
      expect(tickets.initialize().isOk()).toBe(true);
      expect(migrations.initialize().isOk()).toBe(true);

      const resumed = new TicketMigrationService(tickets, migrations, new Clock());
      expect((await resumed.migrate('ticket-1', 'project-1', provider)).isOk()).toBe(true);
      expect(provider.createCalls).toBe(1);
      expect(migrations.getMigration('ticket-1').unwrap()?.stage).toBe('completed');
    } finally {
      migrations.dispose();
      tickets.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
