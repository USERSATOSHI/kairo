import { ok, type Result } from '@usersatoshi/results';

import type { TicketClock, TicketIdGenerator, TicketRepository } from './ports.ts';
import type { TicketError } from '../errors.ts';
import { TicketErrorKind, toTicketError } from '../errors.ts';
import type { TicketRunLauncher, TicketRunQuery, TicketRunStore } from '../integration/ports.ts';
import type {
  TicketBoardCard,
  TicketRunLink,
  TicketRunLinkKind,
  TicketSnapshot,
} from '../integration/types.ts';
import { deriveTicketBoardColumn } from '../integration/policy.ts';

export interface StartTicketRunInput {
  readonly ticketId: string;
  readonly kind: TicketRunLinkKind;
  readonly workflow: string;
  readonly repositoryPath: string;
  readonly actor: string;
  readonly allowParallelVariants?: boolean;
}

export class TicketRunService {
  constructor(
    private readonly tickets: TicketRepository,
    private readonly integrations: TicketRunStore,
    private readonly runs: TicketRunQuery,
    private readonly launcher: TicketRunLauncher,
    private readonly clock: TicketClock,
    private readonly ids: TicketIdGenerator & { snapshotId(): string },
  ) {}

  async start(input: StartTicketRunInput): Promise<Result<TicketRunLink, TicketError>> {
    const ticket = this.tickets.get(input.ticketId);
    if (ticket.isErr()) return ticket;
    if (input.kind === 'implementation' && !input.allowParallelVariants) {
      const links = this.integrations.listRunLinks(input.ticketId);
      if (links.isErr()) return links;
      for (const link of links.unwrap().filter(({ kind }) => kind === 'implementation')) {
        const run = this.runs.get(link.runId);
        if (run.isErr()) return run;
        if (run.value?.active) {
          return toTicketError(TicketErrorKind.InvalidInput, {
            field: 'ticketId',
            reason: 'ticket already has an active implementation run',
          });
        }
      }
    }
    const value = ticket.unwrap();
    const capturedAt = this.clock.now();
    const snapshot: TicketSnapshot = {
      id: this.ids.snapshotId(),
      runId: '',
      ticketId: value.id,
      projectId: value.projectId,
      title: value.title,
      description: value.description,
      ...(value.priority === undefined ? {} : { priority: value.priority }),
      labels: value.labels,
      assignees: value.assignees,
      provider: value.binding.kind,
      providerRevision:
        value.binding.kind === 'local'
          ? String(value.revision)
          : (value.binding.lastSyncedRevision ?? String(value.revision)),
      capturedAt,
    };
    const started = await this.launcher.start({
      ticket: value,
      snapshot,
      workflow: input.workflow,
      repositoryPath: input.repositoryPath,
      actor: input.actor,
    });
    if (started.isErr()) return started;
    const runId = started.unwrap().runId;
    const linkedSnapshot = { ...snapshot, runId };
    const link: TicketRunLink = {
      ticketId: value.id,
      runId,
      kind: input.kind,
      createdAt: capturedAt,
    };
    const recorded = this.integrations.recordRunStart(linkedSnapshot, link);
    return recorded.isErr() ? recorded : ok(link);
  }

  board(projectId: string): Result<readonly TicketBoardCard[], TicketError> {
    const tickets = this.tickets.list(projectId);
    if (tickets.isErr()) return tickets;
    const cards: TicketBoardCard[] = [];
    for (const ticket of tickets.unwrap()) {
      const links = this.integrations.listRunLinks(ticket.id);
      if (links.isErr()) return links;
      let activeRun;
      for (const link of links.unwrap().toReversed()) {
        const run = this.runs.get(link.runId);
        if (run.isErr()) return run;
        if (run.value?.active) {
          activeRun = run.value;
          break;
        }
      }
      cards.push({
        ticket,
        column: deriveTicketBoardColumn(ticket, activeRun),
        ...(activeRun === undefined ? {} : { activeRun }),
      });
    }
    return ok(cards);
  }
}
