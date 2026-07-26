import type { Result } from '@usersatoshi/results';

import type { TicketError } from '../errors.ts';
import type {
  Ticket,
  TicketComment,
  TicketId,
  TicketRelationship,
  TicketStatus,
  UpdateTicketInput,
} from '../domain/types.ts';

export interface ExternalTicketProjection {
  readonly title: string;
  readonly description: string;
  readonly status: TicketStatus;
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
  readonly binding: import('../domain/types.ts').TicketBinding;
}

export interface TicketRepository {
  create(ticket: Ticket): Result<Ticket, TicketError>;
  get(ticketId: TicketId): Result<Ticket, TicketError>;
  list(projectId: string): Result<readonly Ticket[], TicketError>;
  findByBinding(
    binding: import('../domain/types.ts').TicketBinding,
  ): Result<Ticket | undefined, TicketError>;
  update(
    ticketId: TicketId,
    input: UpdateTicketInput,
    updatedAt: string,
  ): Result<Ticket, TicketError>;
  setStatus(
    ticketId: TicketId,
    expectedRevision: number,
    status: TicketStatus,
    updatedAt: string,
  ): Result<Ticket, TicketError>;
  applyExternal(
    ticketId: TicketId,
    projection: ExternalTicketProjection,
    updatedAt: string,
  ): Result<Ticket, TicketError>;
  addComment(comment: TicketComment, updatedAt: string): Result<TicketComment, TicketError>;
  listComments(ticketId: TicketId): Result<readonly TicketComment[], TicketError>;
  addRelationship(relationship: TicketRelationship): Result<TicketRelationship, TicketError>;
  listRelationships(ticketId: TicketId): Result<readonly TicketRelationship[], TicketError>;
}

export interface TicketClock {
  now(): string;
}

export interface TicketIdGenerator {
  ticketId(): TicketId;
  commentId(): string;
}
