import type { Result } from '@usersatoshi/results';

import type {
  AddTicketCommentInput,
  CreateTicketInput,
  ProjectId,
  TicketBinding,
  TicketStatus,
  UpdateTicketInput,
} from '../domain/types.ts';

export const enum TicketProviderErrorKind {
  NotFound = 1,
  AuthenticationFailed = 2,
  PermissionDenied = 3,
  RateLimited = 4,
  Conflict = 5,
  UnsupportedCapability = 6,
  InvalidResponse = 7,
  Unavailable = 8,
  Unknown = 9,
}

export interface TicketProviderError {
  readonly kind: TicketProviderErrorKind;
  readonly code: string;
  readonly message: string;
  readonly retryAfter?: string;
}

export interface ProviderTicket {
  readonly binding: TicketBinding;
  readonly title: string;
  readonly description: string;
  readonly marker?: string;
  readonly status: Extract<TicketStatus, 'backlog' | 'done'>;
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
  readonly milestone?: string;
  readonly revision: string;
  readonly updatedAt: string;
}

export interface ProviderComment {
  readonly externalId: string;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt?: string;
}

export interface TicketProviderCapabilities {
  readonly issues: boolean;
  readonly comments: boolean;
  readonly labels: boolean;
  readonly assignees: boolean;
  readonly milestones: boolean;
  readonly webhooks: boolean;
  readonly projects: boolean;
}

export interface ProviderCreateTicketInput extends CreateTicketInput {
  /**
   * Durable identity embedded in provider-visible content so an interrupted
   * create can be rediscovered before Kouro retries it.
   */
  readonly marker?: string;
  readonly milestone?: string;
}

export interface ProviderUpdateTicketInput extends Omit<UpdateTicketInput, 'expectedRevision'> {
  readonly expectedRevision?: string;
  readonly milestone?: string | null;
}

export interface TicketProvider {
  readonly kind: 'local' | 'github' | 'forgejo';
  get(binding: TicketBinding): Promise<Result<ProviderTicket, TicketProviderError>>;
  list(projectId: ProjectId): Promise<Result<readonly ProviderTicket[], TicketProviderError>>;
  create(
    projectId: ProjectId,
    input: ProviderCreateTicketInput,
  ): Promise<Result<ProviderTicket, TicketProviderError>>;
  update(
    binding: TicketBinding,
    input: ProviderUpdateTicketInput,
  ): Promise<Result<ProviderTicket, TicketProviderError>>;
  addComment(
    binding: TicketBinding,
    input: AddTicketCommentInput,
  ): Promise<Result<ProviderComment, TicketProviderError>>;
  close(binding: TicketBinding): Promise<Result<void, TicketProviderError>>;
  reopen(binding: TicketBinding): Promise<Result<void, TicketProviderError>>;
  detectCapabilities?(): Promise<Result<TicketProviderCapabilities, TicketProviderError>>;
}
