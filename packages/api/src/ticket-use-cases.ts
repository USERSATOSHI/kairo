import type {
  TicketDetails,
  TicketListItem,
  TicketProviderConfigurationView,
  TicketProjectView,
  TicketRunHistoryView,
} from '@kouro/api-contracts';
import {
  deriveTicketBoardColumn,
  TicketErrorKind,
  type TicketError,
  type TicketRunLink,
  type TicketRunView,
} from '@kouro/tickets';
import { ok, type Result } from '@usersatoshi/results';

import { ApiErrorKind, apiErr, type ApiError } from './errors.ts';
import type { TicketProviderConfigurationQuery, TicketReadServices } from './ports.ts';

function fromTicketError<T>(error: TicketError): Result<T, ApiError> {
  switch (error.kind) {
    case TicketErrorKind.InvalidInput:
      return apiErr(ApiErrorKind.InvalidInput, 'invalid_ticket_input', error.reason);
    case TicketErrorKind.NotFound:
      return apiErr(
        ApiErrorKind.NotFound,
        'ticket_not_found',
        `Ticket ${error.ticketId} was not found`,
      );
    case TicketErrorKind.AlreadyExists:
    case TicketErrorKind.RevisionConflict:
    case TicketErrorKind.InvalidStatusTransition:
    case TicketErrorKind.RelationshipConflict:
      return apiErr(ApiErrorKind.Conflict, 'ticket_conflict', 'Ticket state conflicts');
    case TicketErrorKind.DatabaseFailure:
    case TicketErrorKind.CorruptData:
      return apiErr(
        ApiErrorKind.Persistence,
        'ticket_store_failure',
        'Ticket state could not be read',
      );
  }
  throw new Error('Unsupported ticket error kind');
}

function runViews(
  services: TicketReadServices,
  links: readonly TicketRunLink[],
): Result<readonly TicketRunHistoryView[], ApiError> {
  const views: TicketRunHistoryView[] = [];
  for (const link of links) {
    const queried = services.runQuery.get(link.runId);
    if (queried.isErr()) return fromTicketError(queried.error);
    const execution = queried.value;
    views.push({ ...link, ...(execution ? { execution } : {}) });
  }
  return ok(views);
}

function activeRun(runs: readonly TicketRunHistoryView[]): TicketRunView | undefined {
  return runs.toReversed().find(({ execution }) => execution?.active)?.execution;
}

export function listTickets(
  services: TicketReadServices,
  projectId: string,
): Result<readonly TicketListItem[], ApiError> {
  const loaded = services.repository.list(projectId);
  if (loaded.isErr()) return fromTicketError(loaded.error);
  const items: TicketListItem[] = [];
  for (const ticket of loaded.value) {
    const links = services.runs.listRunLinks(ticket.id);
    if (links.isErr()) return fromTicketError(links.error);
    const runs = runViews(services, links.value);
    if (runs.isErr()) return runs;
    const active = activeRun(runs.value);
    items.push({
      ticket,
      column: deriveTicketBoardColumn(ticket, active),
      ...(active ? { activeRun: active } : {}),
    });
  }
  return ok(items);
}

export function listTicketProjects(
  services: TicketReadServices,
): Result<readonly TicketProjectView[], ApiError> {
  const loaded = services.repository.listProjects();
  return loaded.isErr() ? fromTicketError(loaded.error) : ok(loaded.value);
}

export function getTicket(
  services: TicketReadServices,
  ticketId: string,
): Result<TicketDetails, ApiError> {
  const loaded = services.repository.get(ticketId);
  if (loaded.isErr()) return fromTicketError(loaded.error);
  const comments = services.repository.listComments(ticketId);
  if (comments.isErr()) return fromTicketError(comments.error);
  const relationships = services.repository.listRelationships(ticketId);
  if (relationships.isErr()) return fromTicketError(relationships.error);
  const links = services.runs.listRunLinks(ticketId);
  if (links.isErr()) return fromTicketError(links.error);
  const runs = runViews(services, links.value);
  if (runs.isErr()) return runs;
  const snapshots = services.runs.listSnapshots(ticketId);
  if (snapshots.isErr()) return fromTicketError(snapshots.error);
  const syncState = services.sync.getSyncState(ticketId);
  if (syncState.isErr()) return fromTicketError(syncState.error);
  const syncOperations = services.sync.listSyncOperations(ticketId);
  if (syncOperations.isErr()) return fromTicketError(syncOperations.error);
  const migrations = services.sync.listMigrationHistory(ticketId);
  if (migrations.isErr()) return fromTicketError(migrations.error);
  const ticket = loaded.value;
  const active = activeRun(runs.value);
  return ok({
    ticket,
    column: deriveTicketBoardColumn(ticket, active),
    ...(active ? { activeRun: active } : {}),
    comments: comments.value,
    relationships: relationships.value,
    runs: runs.value,
    snapshots: snapshots.value,
    syncState: syncState.value,
    syncOperations: syncOperations.value,
    migrations: migrations.value,
  });
}

const defaultProviderConfigurations: readonly TicketProviderConfigurationView[] = [
  {
    id: 'local',
    displayName: 'Local SQLite',
    configured: true,
    credentialSource: 'none',
    message: 'Available without a remote account or repository.',
  },
  {
    id: 'github',
    displayName: 'GitHub Issues',
    configured: false,
    credentialSource: 'server_environment',
    message: 'Configure the GitHub adapter and token in the server composition.',
  },
  {
    id: 'forgejo',
    displayName: 'Forgejo Issues',
    configured: false,
    credentialSource: 'server_environment',
    message: 'Configure an instance and token in the server composition.',
  },
];

export function listTicketProviderConfigurations(
  query?: TicketProviderConfigurationQuery,
): readonly TicketProviderConfigurationView[] {
  return query?.list() ?? defaultProviderConfigurations;
}
