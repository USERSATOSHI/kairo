import { ok, type Result } from '@usersatoshi/results';

import type { TicketClock, TicketIdGenerator, TicketRepository } from '../application/ports.ts';
import type { Ticket, TicketBinding } from '../domain/types.ts';
import type {
  ActiveRunTicketCommander,
  TicketRunQuery,
  TicketRunStore,
  TicketSyncStore,
} from '../integration/ports.ts';
import { decideActiveRunTicketChange } from '../integration/policy.ts';
import type { TicketChangeKind } from '../integration/types.ts';
import type { ProviderTicket, TicketProvider } from '../provider/types.ts';
import { TicketSyncErrorKind, toTicketSyncError, type TicketSyncError } from './errors.ts';

export interface RunTicketSyncEvent {
  readonly sequence: number;
  readonly type:
    | 'run_started'
    | 'approval_needed'
    | 'run_blocked'
    | 'run_succeeded'
    | 'run_failed'
    | 'run_cancelled';
  readonly runId: string;
  readonly artifactUrl?: string;
}

function ticketFailure<T>(
  result: Result<T, import('../errors.ts').TicketError>,
): Result<T, TicketSyncError> {
  return result.isErr()
    ? toTicketSyncError(TicketSyncErrorKind.Ticket, { error: result.error })
    : result;
}

function providerFailure<T>(
  result: Result<T, import('../provider/types.ts').TicketProviderError>,
): Result<T, TicketSyncError> {
  return result.isErr()
    ? toTicketSyncError(TicketSyncErrorKind.Provider, { error: result.error })
    : result;
}

function changedField(before: Ticket, after: ProviderTicket): TicketChangeKind | undefined {
  if (before.title !== after.title) return 'title';
  if (before.description !== after.description) return 'description';
  if (before.status !== 'done' && after.status === 'done') return 'external_close';
  if (JSON.stringify(before.labels) !== JSON.stringify(after.labels)) return 'labels';
  if (JSON.stringify(before.assignees) !== JSON.stringify(after.assignees)) return 'assignees';
  return undefined;
}

function bindingWithRevision(binding: TicketBinding, revision: string): TicketBinding {
  if (binding.kind === 'local') return binding;
  return { ...binding, lastSyncedRevision: revision };
}

const runEventLabels: Readonly<Record<RunTicketSyncEvent['type'], string>> = {
  run_started: 'kairo:active',
  approval_needed: 'kairo:approval-needed',
  run_blocked: 'kairo:blocked',
  run_failed: 'kairo:blocked',
  run_succeeded: 'kairo:completed',
  run_cancelled: 'kairo:cancelled',
};

export class TicketSyncService {
  constructor(
    private readonly tickets: TicketRepository,
    private readonly sync: TicketSyncStore,
    private readonly clock: TicketClock,
    private readonly ids: TicketIdGenerator,
    private readonly runStore?: TicketRunStore,
    private readonly runs?: TicketRunQuery,
    private readonly commander?: ActiveRunTicketCommander,
  ) {}

  async importProject(
    projectId: string,
    provider: TicketProvider,
  ): Promise<Result<readonly Ticket[], TicketSyncError>> {
    const listed = providerFailure(await provider.list(projectId));
    if (listed.isErr()) return listed;
    const imported: Ticket[] = [];
    for (const providerTicket of listed.unwrap()) {
      const existing = ticketFailure(this.tickets.findByBinding(providerTicket.binding));
      if (existing.isErr()) return existing;
      const existingTicket = existing.value;
      if (existingTicket) {
        const applied = await this.applyProviderTicket(existingTicket, providerTicket);
        if (applied.isErr()) return applied;
        imported.push(applied.unwrap());
        continue;
      }
      const created = ticketFailure(
        this.tickets.create({
          id: this.ids.ticketId(),
          projectId,
          title: providerTicket.title,
          description: providerTicket.description,
          status: providerTicket.status,
          labels: providerTicket.labels,
          assignees: providerTicket.assignees,
          binding: providerTicket.binding,
          revision: 1,
          createdAt: providerTicket.updatedAt,
          updatedAt: providerTicket.updatedAt,
        }),
      );
      if (created.isErr()) return created;
      imported.push(created.unwrap());
    }
    return ok(imported);
  }

  async reconcile(
    ticketId: string,
    provider: TicketProvider,
  ): Promise<Result<Ticket, TicketSyncError>> {
    const ticket = ticketFailure(this.tickets.get(ticketId));
    if (ticket.isErr()) return ticket;
    const value = ticket.unwrap();
    const externalResult = await provider.get(value.binding);
    if (externalResult.isErr()) {
      this.recordFailure(value, externalResult.error.message);
      return toTicketSyncError(TicketSyncErrorKind.Provider, {
        error: externalResult.error,
      });
    }
    const external = externalResult.unwrap();
    if (value.binding.kind !== 'local' && value.binding.lastSyncedRevision === external.revision) {
      this.recordSuccess(value);
      return ticket;
    }
    return this.applyProviderTicket(value, external);
  }

  async syncTicket(
    ticketId: string,
    provider: TicketProvider,
    idempotencyKey: string,
  ): Promise<Result<Ticket, TicketSyncError>> {
    const ticket = ticketFailure(this.tickets.get(ticketId));
    if (ticket.isErr()) return ticket;
    const value = ticket.unwrap();
    const request = JSON.stringify({
      title: value.title,
      description: value.description,
      labels: value.labels,
      assignees: value.assignees,
    });
    const operation = ticketFailure(
      this.sync.recordSyncOperation({
        idempotencyKey,
        ticketId,
        provider: provider.kind,
        operation: 'update',
        status: 'pending',
        request,
        updatedAt: this.clock.now(),
      }),
    );
    if (operation.isErr()) return operation;
    if (!operation.unwrap()) return ticket;
    const updatedResult = await provider.update(value.binding, {
      title: value.title,
      description: value.description,
      labels: value.labels,
      assignees: value.assignees,
      expectedRevision:
        value.binding.kind === 'local' ? undefined : value.binding.lastSyncedRevision,
    });
    if (updatedResult.isErr()) {
      this.recordOperationFailure(
        idempotencyKey,
        value,
        provider,
        request,
        updatedResult.error.message,
      );
      return toTicketSyncError(TicketSyncErrorKind.Provider, {
        error: updatedResult.error,
      });
    }
    const updated = updatedResult.unwrap();
    const applied = await this.applyProviderTicket(value, updated);
    if (applied.isErr()) return applied;
    ticketFailure(
      this.sync.recordSyncOperation({
        idempotencyKey,
        ticketId,
        provider: provider.kind,
        operation: 'update',
        status: 'succeeded',
        request,
        response: JSON.stringify(updated),
        updatedAt: this.clock.now(),
      }),
    );
    return applied;
  }

  async applyWebhook(
    providerEventId: string,
    eventType: string,
    payload: string,
    normalized: ProviderTicket,
  ): Promise<Result<boolean, TicketSyncError>> {
    const received = ticketFailure(
      this.sync.recordExternalEvent({
        provider: normalized.binding.kind === 'forgejo' ? 'forgejo' : 'github',
        providerEventId,
        eventType,
        payload,
        receivedAt: this.clock.now(),
      }),
    );
    if (received.isErr() || !received.unwrap()) return received;
    const existing = ticketFailure(this.tickets.findByBinding(normalized.binding));
    if (existing.isErr()) return existing;
    const existingTicket = existing.value;
    if (existingTicket) {
      const applied = await this.applyProviderTicket(existingTicket, normalized);
      if (applied.isErr()) {
        ticketFailure(
          this.sync.completeExternalEvent(
            normalized.binding.kind,
            providerEventId,
            'webhook reconciliation failed',
          ),
        );
        return applied;
      }
    }
    const completed = ticketFailure(
      this.sync.completeExternalEvent(normalized.binding.kind, providerEventId),
    );
    return completed.isErr() ? completed : ok(true);
  }

  async syncRunEvent(
    ticketId: string,
    provider: TicketProvider,
    event: RunTicketSyncEvent,
    closeOnSuccess: boolean,
  ): Promise<Result<void, TicketSyncError>> {
    const ticket = ticketFailure(this.tickets.get(ticketId));
    if (ticket.isErr()) return ticket;
    const value = ticket.unwrap();
    const message = `${event.type.replaceAll('_', ' ')} for Kairo run ${event.runId}${
      event.artifactUrl ? `\n${event.artifactUrl}` : ''
    }`;
    const key = `ticket:${ticketId}:provider-comment:${event.sequence}`;
    const recorded = ticketFailure(
      this.sync.recordSyncOperation({
        idempotencyKey: key,
        ticketId,
        provider: provider.kind,
        operation: 'comment',
        status: 'pending',
        request: JSON.stringify({ message }),
        updatedAt: this.clock.now(),
      }),
    );
    if (recorded.isErr() || !recorded.unwrap()) {
      return recorded.isErr() ? recorded : ok(undefined);
    }
    const commented = providerFailure(
      await provider.addComment(value.binding, { author: 'kairo', body: message }),
    );
    if (commented.isErr()) return commented;
    const labels = [
      ...value.labels.filter((label) => !label.startsWith('kairo:')),
      runEventLabels[event.type],
    ].toSorted();
    const labelled = providerFailure(
      await provider.update(value.binding, {
        labels,
        expectedRevision:
          value.binding.kind === 'local' ? undefined : value.binding.lastSyncedRevision,
      }),
    );
    if (labelled.isErr()) return labelled;
    if (event.type === 'run_succeeded' && closeOnSuccess) {
      const closed = providerFailure(await provider.close(value.binding));
      if (closed.isErr()) return closed;
    }
    const completed = ticketFailure(
      this.sync.recordSyncOperation({
        idempotencyKey: key,
        ticketId,
        provider: provider.kind,
        operation: 'comment',
        status: 'succeeded',
        request: JSON.stringify({ message }),
        response: JSON.stringify(commented.unwrap()),
        updatedAt: this.clock.now(),
      }),
    );
    if (completed.isErr()) return completed;
    return ok(undefined);
  }

  private async applyProviderTicket(
    before: Ticket,
    providerTicket: ProviderTicket,
  ): Promise<Result<Ticket, TicketSyncError>> {
    const change = changedField(before, providerTicket);
    const applied = ticketFailure(
      this.tickets.applyExternal(
        before.id,
        {
          title: providerTicket.title,
          description: providerTicket.description,
          status:
            providerTicket.status === 'done'
              ? 'done'
              : before.status === 'done'
                ? 'ready'
                : before.status,
          labels: providerTicket.labels,
          assignees: providerTicket.assignees,
          binding: bindingWithRevision(providerTicket.binding, providerTicket.revision),
        },
        providerTicket.updatedAt,
      ),
    );
    if (applied.isErr()) return applied;
    this.recordSuccess(applied.unwrap());
    if (change) {
      const commanded = await this.commandActiveRun(before, change);
      if (commanded.isErr()) return commanded;
    }
    return applied;
  }

  private async commandActiveRun(
    ticket: Ticket,
    change: TicketChangeKind,
  ): Promise<Result<void, TicketSyncError>> {
    if (!this.runStore || !this.runs || !this.commander) return ok(undefined);
    const links = ticketFailure(this.runStore.listRunLinks(ticket.id));
    if (links.isErr()) return links;
    for (const link of links.unwrap().toReversed()) {
      const run = ticketFailure(this.runs.get(link.runId));
      if (run.isErr()) return run;
      if (!run.value?.active) continue;
      const decision = decideActiveRunTicketChange(change);
      const reason = `Ticket ${ticket.id} changed: ${change}`;
      const commanded =
        decision.command === 'pause'
          ? await this.commander.pause(link.runId, reason)
          : decision.command === 'cancel'
            ? await this.commander.cancel(link.runId, reason)
            : decision.command === 'notify'
              ? await this.commander.notify(link.runId, reason)
              : ok(undefined);
      return commanded.isErr()
        ? toTicketSyncError(TicketSyncErrorKind.Command, {
            runId: link.runId,
            error: commanded.error,
          })
        : ok(undefined);
    }
    return ok(undefined);
  }

  private recordSuccess(ticket: Ticket): void {
    this.sync.setSyncState({
      ticketId: ticket.id,
      provider: ticket.binding.kind,
      status: 'succeeded',
      lastSyncedAt: this.clock.now(),
    });
  }

  private recordFailure(ticket: Ticket, message: string): void {
    this.sync.setSyncState({
      ticketId: ticket.id,
      provider: ticket.binding.kind,
      status: 'failed',
      lastError: message,
    });
  }

  private recordOperationFailure(
    idempotencyKey: string,
    ticket: Ticket,
    provider: TicketProvider,
    request: string,
    message: string,
  ): void {
    this.sync.recordSyncOperation({
      idempotencyKey,
      ticketId: ticket.id,
      provider: provider.kind,
      operation: 'update',
      status: 'failed',
      request,
      error: message,
      updatedAt: this.clock.now(),
    });
    this.recordFailure(ticket, message);
  }
}
