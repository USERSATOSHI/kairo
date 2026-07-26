import { createHash } from 'node:crypto';

import type { JsonValue, WorkItemSnapshot } from '@kairo/domain';
import type { ResolvedTicket, TicketProvider } from '@kairo/executors';
import type { Ticket, TicketSnapshot } from '@kairo/tickets';
import { err, ok, type Result } from '@usersatoshi/results';

export const enum WorkItemResolutionErrorKind {
  InvalidInput = 0,
  Provider = 1,
}

export interface WorkItemResolutionError {
  readonly kind: WorkItemResolutionErrorKind;
  readonly code: string;
  readonly message: string;
}

interface SnapshotSource {
  readonly kind: WorkItemSnapshot['kind'];
  readonly provider: string;
  readonly reference: string;
  readonly revision?: string;
  readonly url?: string;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: readonly string[];
  readonly labels: readonly string[];
}

function normalizedStrings(values: readonly string[], sort: boolean): readonly string[] {
  const normalized = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  return sort ? normalized.toSorted() : normalized;
}

function checksum(source: SnapshotSource): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(JSON.stringify(source)).digest('hex')}`;
}

function snapshot(source: SnapshotSource): Result<WorkItemSnapshot, WorkItemResolutionError> {
  if (!source.title.trim() || !source.description.trim()) {
    return err({
      kind: WorkItemResolutionErrorKind.InvalidInput,
      code: 'invalid_work_item',
      message: 'Work-item title and description must be non-empty',
    });
  }
  const normalized: SnapshotSource = {
    ...source,
    title: source.title.trim(),
    description: source.description.trim(),
    acceptanceCriteria: normalizedStrings(source.acceptanceCriteria, false),
    labels: normalizedStrings(source.labels, true),
  };
  return ok({
    schemaVersion: 1,
    ...normalized,
    checksum: checksum(normalized),
  });
}

function inlineTitle(task: string): string {
  const firstLine = task
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine?.replace(/^#+\s*/, '') ?? '';
}

export function createInlineWorkItem(
  task: string,
): Result<WorkItemSnapshot, WorkItemResolutionError> {
  const description = task.trim();
  return snapshot({
    kind: 'inline',
    provider: 'inline',
    reference: 'inline',
    title: inlineTitle(description),
    description,
    acceptanceCriteria: [],
    labels: [],
  });
}

export function createStoredTicketWorkItem(
  ticket: Ticket,
  stored: TicketSnapshot,
): Result<WorkItemSnapshot, WorkItemResolutionError> {
  return snapshot({
    kind: 'ticket',
    provider: 'kairo',
    reference: ticket.id,
    revision: stored.providerRevision,
    ...(ticket.binding.kind === 'local' ? {} : { url: ticket.binding.externalUrl }),
    title: stored.title,
    description: stored.description,
    acceptanceCriteria: [],
    labels: stored.labels,
  });
}

function splitTicketReference(
  ticket: string,
): Result<{ readonly provider: string; readonly reference: string }, WorkItemResolutionError> {
  const separator = ticket.indexOf(':');
  const provider = separator < 0 ? '' : ticket.slice(0, separator).trim();
  const reference = separator < 0 ? '' : ticket.slice(separator + 1).trim();
  return provider && reference
    ? ok({ provider, reference })
    : err({
        kind: WorkItemResolutionErrorKind.InvalidInput,
        code: 'invalid_ticket_reference',
        message: 'Ticket references must use <provider>:<reference>',
      });
}

function ticketSnapshot(
  provider: string,
  ticket: ResolvedTicket,
): Result<WorkItemSnapshot, WorkItemResolutionError> {
  if (!ticket.reference.trim() || !ticket.revision.trim()) {
    return err({
      kind: WorkItemResolutionErrorKind.Provider,
      code: 'invalid_ticket',
      message: `Ticket provider ${provider} returned an empty reference or revision`,
    });
  }
  return snapshot({
    kind: 'ticket',
    provider,
    reference: ticket.reference,
    revision: ticket.revision,
    ...(ticket.url?.trim() ? { url: ticket.url.trim() } : {}),
    title: ticket.title,
    description: ticket.description,
    acceptanceCriteria: ticket.acceptanceCriteria ?? [],
    labels: ticket.labels ?? [],
  });
}

export async function resolveTicketWorkItem(
  ticket: string,
  providers: ReadonlyMap<string, TicketProvider>,
): Promise<Result<WorkItemSnapshot, WorkItemResolutionError>> {
  const parsed = splitTicketReference(ticket);
  if (parsed.isErr()) return parsed;
  const { provider, reference } = parsed.unwrap();
  const adapter = providers.get(provider);
  if (!adapter) {
    return err({
      kind: WorkItemResolutionErrorKind.InvalidInput,
      code: 'ticket_provider_not_configured',
      message: `Ticket provider ${provider} is not configured`,
    });
  }
  const resolved = await adapter.resolve(reference);
  if (resolved.isErr()) {
    return err({
      kind: WorkItemResolutionErrorKind.Provider,
      code: resolved.error.code,
      message: resolved.error.message,
    });
  }
  return ticketSnapshot(provider, resolved.unwrap());
}

export function workItemConfiguration(workItem: WorkItemSnapshot): JsonValue {
  return {
    schemaVersion: workItem.schemaVersion,
    kind: workItem.kind,
    provider: workItem.provider,
    reference: workItem.reference,
    ...(workItem.revision ? { revision: workItem.revision } : {}),
    ...(workItem.url ? { url: workItem.url } : {}),
    title: workItem.title,
    description: workItem.description,
    acceptanceCriteria: workItem.acceptanceCriteria,
    labels: workItem.labels,
    checksum: workItem.checksum,
  };
}
