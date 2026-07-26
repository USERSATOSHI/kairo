import { ok, type Result } from '@usersatoshi/results';

import { TicketErrorKind, toTicketError, type TicketError } from '../errors.ts';
import type {
  CreateTicketInput,
  TicketBinding,
  TicketPriority,
  TicketRelationship,
  TicketStatus,
  UpdateTicketInput,
} from './types.ts';

const ticketStatuses: readonly TicketStatus[] = [
  'backlog',
  'ready',
  'blocked',
  'done',
  'cancelled',
];
const ticketStatusValues: ReadonlySet<string> = new Set(ticketStatuses);
const ticketPriorities: readonly TicketPriority[] = ['low', 'medium', 'high', 'critical'];

function validateRequiredText(field: string, value: string): Result<string, TicketError> {
  const normalized = value.trim();
  return normalized.length === 0
    ? toTicketError(TicketErrorKind.InvalidInput, {
        field,
        reason: 'must not be empty',
      })
    : ok(normalized);
}

export function normalizeStringSet(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].toSorted();
}

export function validateCreateTicketInput(
  input: CreateTicketInput,
): Result<CreateTicketInput, TicketError> {
  const projectId = validateRequiredText('projectId', input.projectId);
  if (projectId.isErr()) return projectId;
  const title = validateRequiredText('title', input.title);
  if (title.isErr()) return title;
  if (input.priority !== undefined && !ticketPriorities.includes(input.priority)) {
    return toTicketError(TicketErrorKind.InvalidInput, {
      field: 'priority',
      reason: 'is not a supported ticket priority',
    });
  }
  return ok({
    ...input,
    projectId: projectId.unwrap(),
    title: title.unwrap(),
    description: input.description.trim(),
    labels: normalizeStringSet(input.labels ?? []),
    assignees: normalizeStringSet(input.assignees ?? []),
  });
}

export function validateUpdateTicketInput(
  input: UpdateTicketInput,
): Result<UpdateTicketInput, TicketError> {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    return toTicketError(TicketErrorKind.InvalidInput, {
      field: 'expectedRevision',
      reason: 'must be a positive integer',
    });
  }
  if (input.title !== undefined) {
    const title = validateRequiredText('title', input.title);
    if (title.isErr()) return title;
  }
  if (
    input.priority !== undefined &&
    input.priority !== null &&
    !ticketPriorities.includes(input.priority)
  ) {
    return toTicketError(TicketErrorKind.InvalidInput, {
      field: 'priority',
      reason: 'is not a supported ticket priority',
    });
  }
  return ok({
    ...input,
    ...(input.title === undefined ? {} : { title: input.title.trim() }),
    ...(input.description === undefined ? {} : { description: input.description.trim() }),
    ...(input.labels === undefined ? {} : { labels: normalizeStringSet(input.labels) }),
    ...(input.assignees === undefined ? {} : { assignees: normalizeStringSet(input.assignees) }),
  });
}

export function validateTicketStatus(value: string): value is TicketStatus {
  return ticketStatusValues.has(value);
}

export function validateTicketBinding(binding: TicketBinding): Result<void, TicketError> {
  if (binding.kind === 'local') return ok(undefined);
  if (binding.issueNumber < 1 || !Number.isSafeInteger(binding.issueNumber)) {
    return toTicketError(TicketErrorKind.InvalidInput, {
      field: 'binding.issueNumber',
      reason: 'must be a positive integer',
    });
  }
  const fields =
    binding.kind === 'forgejo'
      ? [binding.instanceUrl, binding.owner, binding.repository, binding.externalUrl]
      : [binding.owner, binding.repository, binding.externalUrl];
  return fields.every((value) => value.trim().length > 0)
    ? ok(undefined)
    : toTicketError(TicketErrorKind.InvalidInput, {
        field: 'binding',
        reason: 'provider binding fields must not be empty',
      });
}

export function validateRelationship(relationship: TicketRelationship): Result<void, TicketError> {
  if (relationship.sourceTicketId === relationship.targetTicketId) {
    return toTicketError(TicketErrorKind.RelationshipConflict, {
      sourceTicketId: relationship.sourceTicketId,
      targetTicketId: relationship.targetTicketId,
      reason: 'a ticket cannot relate to itself',
    });
  }
  return ok(undefined);
}
