export type TicketId = string;
export type ProjectId = string;
export type RunId = string;

export type TicketStatus = 'backlog' | 'ready' | 'blocked' | 'done' | 'cancelled';

export type TicketPriority = 'low' | 'medium' | 'high' | 'critical';

export type TicketBinding =
  | {
      readonly kind: 'local';
    }
  | {
      readonly kind: 'github';
      readonly owner: string;
      readonly repository: string;
      readonly issueNumber: number;
      readonly externalUrl: string;
      readonly lastSyncedRevision?: string;
    }
  | {
      readonly kind: 'forgejo';
      readonly instanceUrl: string;
      readonly owner: string;
      readonly repository: string;
      readonly issueNumber: number;
      readonly externalUrl: string;
      readonly lastSyncedRevision?: string;
    };

export interface Ticket {
  readonly id: TicketId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly description: string;
  readonly status: TicketStatus;
  readonly priority?: TicketPriority;
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
  readonly binding: TicketBinding;
  readonly revision: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type TicketCommentBinding =
  | {
      readonly kind: 'local';
    }
  | {
      readonly kind: 'github';
      readonly externalId: string;
    }
  | {
      readonly kind: 'forgejo';
      readonly externalId: string;
    };

export interface TicketComment {
  readonly id: string;
  readonly ticketId: TicketId;
  readonly author: string;
  readonly body: string;
  readonly binding: TicketCommentBinding;
  readonly createdAt: string;
  readonly updatedAt?: string;
}

export type TicketRelationshipKind = 'blocks' | 'blocked_by' | 'parent' | 'child' | 'related';

export interface TicketRelationship {
  readonly sourceTicketId: TicketId;
  readonly targetTicketId: TicketId;
  readonly kind: TicketRelationshipKind;
}

export interface CreateTicketInput {
  readonly projectId: ProjectId;
  readonly title: string;
  readonly description: string;
  readonly priority?: TicketPriority;
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
}

export interface UpdateTicketInput {
  readonly expectedRevision: number;
  readonly title?: string;
  readonly description?: string;
  readonly priority?: TicketPriority | null;
  readonly labels?: readonly string[];
  readonly assignees?: readonly string[];
}

export interface AddTicketCommentInput {
  readonly author: string;
  readonly body: string;
}
