import {
  SqliteTicketRepository,
  TicketService,
  type AddTicketCommentInput,
  type CreateTicketInput,
  type Ticket,
  type TicketClock,
  type TicketComment,
  type TicketError,
  type TicketIdGenerator,
  type TicketRelationship,
  type TicketStatus,
  type UpdateTicketInput,
} from '@kairo/tickets';
import type { Result } from '@usersatoshi/results';

const systemClock: TicketClock = {
  now(): string {
    return new Date().toISOString();
  },
};

const randomIds: TicketIdGenerator = {
  ticketId(): string {
    return crypto.randomUUID();
  },
  commentId(): string {
    return crypto.randomUUID();
  },
};

export interface LocalTicketProviderOptions {
  readonly clock?: TicketClock;
  readonly ids?: TicketIdGenerator;
}

/**
 * Owns the lifecycle of the local SQLite ticket adapter.
 */
export class LocalTicketProvider {
  readonly kind = 'local' as const;

  private readonly repository: SqliteTicketRepository;
  private readonly service: TicketService;

  constructor(path: string, options: LocalTicketProviderOptions = {}) {
    this.repository = new SqliteTicketRepository(path);
    this.service = new TicketService(
      this.repository,
      options.clock ?? systemClock,
      options.ids ?? randomIds,
    );
  }

  initialize(): Result<void, TicketError> {
    return this.repository.initialize();
  }

  dispose(): void {
    this.repository.dispose();
  }

  create(input: CreateTicketInput): Result<Ticket, TicketError> {
    return this.service.create(input);
  }

  get(ticketId: string): Result<Ticket, TicketError> {
    return this.service.get(ticketId);
  }

  list(projectId: string): Result<readonly Ticket[], TicketError> {
    return this.service.list(projectId);
  }

  update(ticketId: string, input: UpdateTicketInput): Result<Ticket, TicketError> {
    return this.service.update(ticketId, input);
  }

  move(
    ticketId: string,
    expectedRevision: number,
    status: TicketStatus,
  ): Result<Ticket, TicketError> {
    return this.service.move(ticketId, expectedRevision, status);
  }

  close(ticketId: string, expectedRevision: number): Result<Ticket, TicketError> {
    return this.service.close(ticketId, expectedRevision);
  }

  cancel(ticketId: string, expectedRevision: number): Result<Ticket, TicketError> {
    return this.service.cancel(ticketId, expectedRevision);
  }

  reopen(ticketId: string, expectedRevision: number): Result<Ticket, TicketError> {
    return this.service.reopen(ticketId, expectedRevision);
  }

  addComment(ticketId: string, input: AddTicketCommentInput): Result<TicketComment, TicketError> {
    return this.service.addComment(ticketId, input);
  }

  listComments(ticketId: string): Result<readonly TicketComment[], TicketError> {
    return this.service.listComments(ticketId);
  }

  addRelationship(relationship: TicketRelationship): Result<TicketRelationship, TicketError> {
    return this.service.addRelationship(relationship);
  }

  listRelationships(ticketId: string): Result<readonly TicketRelationship[], TicketError> {
    return this.service.listRelationships(ticketId);
  }
}
