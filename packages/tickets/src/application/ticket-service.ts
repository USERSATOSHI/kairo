import type { Result } from '@usersatoshi/results';

import {
  normalizeStringSet,
  validateCreateTicketInput,
  validateRelationship,
  validateUpdateTicketInput,
} from '../domain/validation.ts';
import type {
  AddTicketCommentInput,
  CreateTicketInput,
  Ticket,
  TicketComment,
  TicketId,
  TicketRelationship,
  TicketStatus,
  UpdateTicketInput,
} from '../domain/types.ts';
import { TicketErrorKind, toTicketError, type TicketError } from '../errors.ts';
import { canMovePlanningTicket } from '../kanban/planning-board.ts';
import type { TicketClock, TicketIdGenerator, TicketRepository } from './ports.ts';

/**
 * Coordinates local ticket commands while keeping persistence behind a port.
 */
export class TicketService {
  constructor(
    private readonly repository: TicketRepository,
    private readonly clock: TicketClock,
    private readonly ids: TicketIdGenerator,
  ) {}

  create(input: CreateTicketInput): Result<Ticket, TicketError> {
    const validated = validateCreateTicketInput(input);
    if (validated.isErr()) return validated;
    const normalized = validated.unwrap();
    const now = this.clock.now();
    return this.repository.create({
      id: this.ids.ticketId(),
      projectId: normalized.projectId,
      title: normalized.title,
      description: normalized.description,
      status: 'backlog',
      ...(normalized.priority === undefined ? {} : { priority: normalized.priority }),
      labels: normalizeStringSet(normalized.labels ?? []),
      assignees: normalizeStringSet(normalized.assignees ?? []),
      binding: { kind: 'local' },
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  get(ticketId: TicketId): Result<Ticket, TicketError> {
    return this.repository.get(ticketId);
  }

  list(projectId: string): Result<readonly Ticket[], TicketError> {
    return projectId.trim().length === 0
      ? toTicketError(TicketErrorKind.InvalidInput, {
          field: 'projectId',
          reason: 'must not be empty',
        })
      : this.repository.list(projectId.trim());
  }

  update(ticketId: TicketId, input: UpdateTicketInput): Result<Ticket, TicketError> {
    const validated = validateUpdateTicketInput(input);
    return validated.isErr()
      ? validated
      : this.repository.update(ticketId, validated.unwrap(), this.clock.now());
  }

  move(
    ticketId: TicketId,
    expectedRevision: number,
    status: TicketStatus,
  ): Result<Ticket, TicketError> {
    const current = this.repository.get(ticketId);
    if (current.isErr()) return current;
    const ticket = current.unwrap();
    if (ticket.revision !== expectedRevision) {
      return toTicketError(TicketErrorKind.RevisionConflict, {
        ticketId,
        expected: expectedRevision,
        actual: ticket.revision,
      });
    }
    if (!canMovePlanningTicket(ticket.status, status)) {
      return toTicketError(TicketErrorKind.InvalidStatusTransition, {
        ticketId,
        from: ticket.status,
        to: status,
      });
    }
    return this.repository.setStatus(ticketId, expectedRevision, status, this.clock.now());
  }

  close(ticketId: TicketId, expectedRevision: number): Result<Ticket, TicketError> {
    return this.repository.setStatus(ticketId, expectedRevision, 'done', this.clock.now());
  }

  cancel(ticketId: TicketId, expectedRevision: number): Result<Ticket, TicketError> {
    return this.repository.setStatus(ticketId, expectedRevision, 'cancelled', this.clock.now());
  }

  reopen(ticketId: TicketId, expectedRevision: number): Result<Ticket, TicketError> {
    const current = this.repository.get(ticketId);
    if (current.isErr()) return current;
    const ticket = current.unwrap();
    if (ticket.status !== 'done' && ticket.status !== 'cancelled') {
      return toTicketError(TicketErrorKind.InvalidStatusTransition, {
        ticketId,
        from: ticket.status,
        to: 'ready',
      });
    }
    return this.repository.setStatus(ticketId, expectedRevision, 'ready', this.clock.now());
  }

  addComment(ticketId: TicketId, input: AddTicketCommentInput): Result<TicketComment, TicketError> {
    const author = input.author.trim();
    const body = input.body.trim();
    if (author.length === 0 || body.length === 0) {
      return toTicketError(TicketErrorKind.InvalidInput, {
        field: author.length === 0 ? 'author' : 'body',
        reason: 'must not be empty',
      });
    }
    const now = this.clock.now();
    return this.repository.addComment(
      {
        id: this.ids.commentId(),
        ticketId,
        author,
        body,
        binding: { kind: 'local' },
        createdAt: now,
      },
      now,
    );
  }

  listComments(ticketId: TicketId): Result<readonly TicketComment[], TicketError> {
    return this.repository.listComments(ticketId);
  }

  addRelationship(relationship: TicketRelationship): Result<TicketRelationship, TicketError> {
    const validated = validateRelationship(relationship);
    return validated.isErr() ? validated : this.repository.addRelationship(relationship);
  }

  listRelationships(ticketId: TicketId): Result<readonly TicketRelationship[], TicketError> {
    return this.repository.listRelationships(ticketId);
  }
}
