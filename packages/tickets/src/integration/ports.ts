import type { Result } from '@usersatoshi/results';

import type { Ticket, TicketBinding, TicketId } from '../domain/types.ts';
import type { TicketError } from '../errors.ts';
import type {
  ExternalTicketEvent,
  ForgejoInstanceMetadata,
  TicketRunLink,
  TicketRunView,
  TicketSnapshot,
  TicketSyncState,
} from './types.ts';

export interface TicketRunStore {
  recordRunStart(snapshot: TicketSnapshot, link: TicketRunLink): Result<void, TicketError>;
  listSnapshots(ticketId: TicketId): Result<readonly TicketSnapshot[], TicketError>;
  listRunLinks(ticketId: TicketId): Result<readonly TicketRunLink[], TicketError>;
}

export interface TicketSyncStore {
  recordExternalEvent(event: ExternalTicketEvent): Result<boolean, TicketError>;
  completeExternalEvent(
    provider: string,
    providerEventId: string,
    error?: string,
  ): Result<void, TicketError>;
  getSyncState(ticketId: TicketId): Result<TicketSyncState, TicketError>;
  setSyncState(state: TicketSyncState): Result<void, TicketError>;
  recordSyncOperation(input: {
    readonly idempotencyKey: string;
    readonly ticketId: TicketId;
    readonly provider: string;
    readonly operation: string;
    readonly status: 'pending' | 'succeeded' | 'failed';
    readonly request: string;
    readonly response?: string;
    readonly error?: string;
    readonly updatedAt: string;
  }): Result<boolean, TicketError>;
}

export interface ForgejoMetadataStore {
  saveForgejoMetadata(metadata: ForgejoInstanceMetadata): Result<void, TicketError>;
  getForgejoMetadata(instanceUrl: string): Result<ForgejoInstanceMetadata | undefined, TicketError>;
}

export interface TicketRunQuery {
  get(runId: string): Result<TicketRunView | undefined, TicketError>;
}

export interface TicketRunLauncher {
  start(input: {
    readonly ticket: Ticket;
    readonly snapshot: TicketSnapshot;
    readonly workflow: string;
    readonly repositoryPath: string;
    readonly actor: string;
  }): Promise<Result<{ readonly runId: string }, TicketError>>;
}

export interface ActiveRunTicketCommander {
  notify(runId: string, message: string): Promise<Result<void, TicketError>>;
  pause(runId: string, reason: string): Promise<Result<void, TicketError>>;
  cancel(runId: string, reason: string): Promise<Result<void, TicketError>>;
}

export interface TicketBindingWriter {
  setBinding(
    ticketId: TicketId,
    binding: TicketBinding,
    updatedAt: string,
  ): Result<Ticket, TicketError>;
}
