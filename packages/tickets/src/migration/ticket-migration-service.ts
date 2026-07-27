import { err, ok, type Result } from '@usersatoshi/results';

import type { TicketRepository, TicketClock } from '../application/ports.ts';
import type { Ticket, TicketBinding } from '../domain/types.ts';
import type { TicketBindingWriter, TicketMigrationStore } from '../integration/ports.ts';
import type { TicketMigration, TicketMigrationSnapshot } from '../integration/types.ts';
import type { ProviderTicket, TicketProvider } from '../provider/types.ts';
import {
  TicketMigrationErrorKind,
  toTicketMigrationError,
  type TicketMigrationError,
} from './errors.ts';

type RemoteTicketProvider = TicketProvider & {
  readonly kind: 'github' | 'forgejo';
};

function isRemoteProvider(provider: TicketProvider): provider is RemoteTicketProvider {
  return provider.kind === 'github' || provider.kind === 'forgejo';
}

function ticketFailure<T>(
  result: Result<T, import('../errors.ts').TicketError>,
): Result<T, TicketMigrationError> {
  return result.isErr()
    ? toTicketMigrationError(TicketMigrationErrorKind.Ticket, { error: result.error })
    : result;
}

function providerFailure<T>(
  result: Result<T, import('../provider/types.ts').TicketProviderError>,
): Result<T, TicketMigrationError> {
  return result.isErr()
    ? toTicketMigrationError(TicketMigrationErrorKind.Provider, { error: result.error })
    : result;
}

function snapshotOf(ticket: Ticket): TicketMigrationSnapshot {
  return {
    revision: ticket.revision,
    title: ticket.title,
    description: ticket.description,
    status: ticket.status,
    labels: ticket.labels,
    assignees: ticket.assignees,
  };
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return JSON.stringify(left.toSorted()) === JSON.stringify(right.toSorted());
}

function sameRemoteBinding(left: TicketBinding, right: TicketBinding): boolean {
  if (left.kind === 'local' || right.kind === 'local' || left.kind !== right.kind) return false;
  if (
    left.owner !== right.owner ||
    left.repository !== right.repository ||
    left.issueNumber !== right.issueNumber
  ) {
    return false;
  }
  return left.kind === 'github' || right.kind === 'github'
    ? left.kind === right.kind
    : left.instanceUrl === right.instanceUrl;
}

function verifyRemoteTicket(
  migration: TicketMigration,
  remote: ProviderTicket,
): Result<void, TicketMigrationError> {
  const snapshot = migration.snapshot;
  const expectedStatus =
    snapshot.status === 'done' || snapshot.status === 'cancelled' ? 'done' : 'backlog';
  const failures: string[] = [];
  if (remote.binding.kind !== migration.targetProvider) failures.push('provider binding');
  if (remote.title !== snapshot.title) failures.push('title');
  if (remote.description !== snapshot.description) failures.push('description');
  if (remote.marker !== migration.marker) failures.push('migration marker');
  if (remote.status !== expectedStatus) failures.push('status');
  if (!sameStrings(remote.labels, snapshot.labels)) failures.push('labels');
  if (!sameStrings(remote.assignees, snapshot.assignees)) failures.push('assignees');
  return failures.length === 0
    ? ok(undefined)
    : toTicketMigrationError(TicketMigrationErrorKind.VerificationFailed, {
        ticketId: migration.ticketId,
        reason: `remote read-back differs in: ${failures.join(', ')}`,
      });
}

/**
 * Moves local ticket authority to a remote provider through durable,
 * independently resumable steps.
 */
export class TicketMigrationService {
  constructor(
    private readonly tickets: TicketRepository & TicketBindingWriter,
    private readonly migrations: TicketMigrationStore,
    private readonly clock: TicketClock,
  ) {}

  async migrate(
    ticketId: string,
    projectId: string,
    provider: TicketProvider,
  ): Promise<Result<Ticket, TicketMigrationError>> {
    if (!isRemoteProvider(provider)) {
      return toTicketMigrationError(TicketMigrationErrorKind.InvalidSource, {
        ticketId,
        reason: 'migration target must be GitHub or Forgejo',
      });
    }
    const loaded = ticketFailure(this.tickets.get(ticketId));
    if (loaded.isErr()) return loaded;
    const migration = await this.prepare(loaded.unwrap(), projectId.trim(), provider);
    if (migration.isErr()) return migration;
    return this.resume(migration.unwrap(), provider);
  }

  private async prepare(
    ticket: Ticket,
    projectId: string,
    provider: RemoteTicketProvider,
  ): Promise<Result<TicketMigration, TicketMigrationError>> {
    const existing = ticketFailure(this.migrations.getMigration(ticket.id));
    if (existing.isErr()) return existing;
    if (existing.value) {
      if (
        existing.value.targetProvider !== provider.kind ||
        existing.value.projectId !== projectId
      ) {
        return toTicketMigrationError(TicketMigrationErrorKind.Conflict, {
          ticketId: ticket.id,
          reason: 'ticket already has a migration to a different target',
        });
      }
      return ok(existing.value);
    }
    if (ticket.binding.kind !== 'local') {
      return toTicketMigrationError(TicketMigrationErrorKind.InvalidSource, {
        ticketId: ticket.id,
        reason: 'only locally authoritative tickets can be migrated',
      });
    }
    if (projectId.length === 0) {
      return toTicketMigrationError(TicketMigrationErrorKind.Conflict, {
        ticketId: ticket.id,
        reason: 'target project must not be empty',
      });
    }
    const now = this.clock.now();
    const prepared: TicketMigration = {
      ticketId: ticket.id,
      targetProvider: provider.kind,
      projectId,
      marker: `kouro-ticket:${ticket.id}`,
      stage: 'prepared',
      snapshot: snapshotOf(ticket),
      createdAt: now,
      updatedAt: now,
    };
    const saved = ticketFailure(this.migrations.saveMigration(prepared));
    return saved.isErr() ? saved : ok(prepared);
  }

  private async resume(
    initial: TicketMigration,
    provider: RemoteTicketProvider,
  ): Promise<Result<Ticket, TicketMigrationError>> {
    let migration = initial;
    if (migration.stage === 'completed') return ticketFailure(this.tickets.get(migration.ticketId));

    const source = ticketFailure(this.tickets.get(migration.ticketId));
    if (source.isErr()) return source;
    const sourceTicket = source.unwrap();
    const sourceValid = this.validateSource(sourceTicket, migration);
    if (sourceValid.isErr()) return sourceValid;

    if (migration.stage === 'prepared') {
      const created = await this.findOrCreate(migration, provider);
      if (created.isErr()) return created;
      const advanced = this.saveStage(migration, 'remote_created', created.unwrap());
      if (advanced.isErr()) return advanced;
      migration = advanced.unwrap();
    }

    if (migration.stage === 'remote_created') {
      const verified = await this.verify(migration, provider);
      if (verified.isErr()) return verified;
      migration = verified.unwrap();
    }

    if (migration.stage === 'verified') return this.complete(migration);

    return ticketFailure(this.tickets.get(migration.ticketId));
  }

  private async verify(
    migration: TicketMigration,
    provider: RemoteTicketProvider,
  ): Promise<Result<TicketMigration, TicketMigrationError>> {
    const remote = migration.remoteTicket;
    if (!remote) {
      return toTicketMigrationError(TicketMigrationErrorKind.VerificationFailed, {
        ticketId: migration.ticketId,
        reason: 'remote-created migration has no remote ticket',
      });
    }
    if (migration.snapshot.status === 'done' || migration.snapshot.status === 'cancelled') {
      const closed = providerFailure(await provider.close(remote.binding));
      if (closed.isErr()) return this.recordFailure(migration, closed.error);
    }
    const fetched = providerFailure(await provider.get(remote.binding));
    if (fetched.isErr()) return this.recordFailure(migration, fetched.error);
    const verified = verifyRemoteTicket(migration, fetched.unwrap());
    if (verified.isErr()) return this.recordFailure(migration, verified.error);
    return this.saveStage(migration, 'verified', fetched.unwrap());
  }

  private complete(migration: TicketMigration): Result<Ticket, TicketMigrationError> {
    const remote = migration.remoteTicket;
    if (!remote || remote.binding.kind === 'local') {
      return toTicketMigrationError(TicketMigrationErrorKind.VerificationFailed, {
        ticketId: migration.ticketId,
        reason: 'verified migration has no remote binding',
      });
    }
    const current = ticketFailure(this.tickets.get(migration.ticketId));
    if (current.isErr()) return current;
    const currentTicket = current.unwrap();
    let migrated = currentTicket;
    if (currentTicket.binding.kind === 'local') {
      const switched = ticketFailure(
        this.tickets.setBinding(
          migration.ticketId,
          migration.snapshot.revision,
          {
            ...remote.binding,
            lastSyncedRevision: remote.revision,
          },
          this.clock.now(),
        ),
      );
      if (switched.isErr()) return switched;
      migrated = switched.unwrap();
    } else if (!sameRemoteBinding(currentTicket.binding, remote.binding)) {
      return toTicketMigrationError(TicketMigrationErrorKind.Conflict, {
        ticketId: migration.ticketId,
        reason: 'ticket authority changed to a different remote issue',
      });
    }
    const completed = this.saveStage(migration, 'completed', remote);
    return completed.isErr() ? completed : ok(migrated);
  }

  private validateSource(
    ticket: Ticket,
    migration: TicketMigration,
  ): Result<void, TicketMigrationError> {
    if (ticket.binding.kind === 'local') {
      return ticket.revision === migration.snapshot.revision
        ? ok(undefined)
        : toTicketMigrationError(TicketMigrationErrorKind.Conflict, {
            ticketId: ticket.id,
            reason: 'local ticket changed after migration was prepared',
          });
    }
    if (
      migration.remoteTicket &&
      sameRemoteBinding(ticket.binding, migration.remoteTicket.binding)
    ) {
      return ok(undefined);
    }
    return toTicketMigrationError(TicketMigrationErrorKind.Conflict, {
      ticketId: ticket.id,
      reason: 'ticket authority changed while migration was in progress',
    });
  }

  private async findOrCreate(
    migration: TicketMigration,
    provider: RemoteTicketProvider,
  ): Promise<Result<ProviderTicket, TicketMigrationError>> {
    const listed = providerFailure(await provider.list(migration.projectId));
    if (listed.isErr()) return this.recordFailure(migration, listed.error);
    const matches = listed.unwrap().filter((ticket) => ticket.marker === migration.marker);
    if (matches.length > 1) {
      const failure = toTicketMigrationError(TicketMigrationErrorKind.VerificationFailed, {
        ticketId: migration.ticketId,
        reason: 'multiple remote issues contain the migration marker',
      });
      return this.recordFailure(migration, failure.error);
    }
    const existing = matches[0];
    if (existing) return ok(existing);
    const created = providerFailure(
      await provider.create(migration.projectId, {
        projectId: migration.projectId,
        title: migration.snapshot.title,
        description: migration.snapshot.description,
        labels: migration.snapshot.labels,
        assignees: migration.snapshot.assignees,
        marker: migration.marker,
      }),
    );
    return created.isErr() ? this.recordFailure(migration, created.error) : created;
  }

  private saveStage(
    migration: TicketMigration,
    stage: TicketMigration['stage'],
    remoteTicket: ProviderTicket,
  ): Result<TicketMigration, TicketMigrationError> {
    const advanced: TicketMigration = {
      ticketId: migration.ticketId,
      targetProvider: migration.targetProvider,
      projectId: migration.projectId,
      marker: migration.marker,
      stage,
      snapshot: migration.snapshot,
      remoteTicket,
      createdAt: migration.createdAt,
      updatedAt: this.clock.now(),
    };
    const saved = ticketFailure(this.migrations.saveMigration(advanced));
    return saved.isErr() ? saved : ok(advanced);
  }

  private recordFailure(
    migration: TicketMigration,
    error: TicketMigrationError,
  ): Result<never, TicketMigrationError> {
    const failed: TicketMigration = {
      ...migration,
      lastError: JSON.stringify(error),
      updatedAt: this.clock.now(),
    };
    const saved = ticketFailure(this.migrations.saveMigration(failed));
    return saved.isErr() ? saved : err(error);
  }
}
