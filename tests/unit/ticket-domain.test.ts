import { describe, expect, test } from 'bun:test';

import {
  normalizeStringSet,
  TicketErrorKind,
  validateCreateTicketInput,
  validateRelationship,
  validateTicketBinding,
  validateUpdateTicketInput,
} from '@kouro/tickets';

describe('ticket domain validation', () => {
  test('normalizes ticket labels and assignees deterministically', () => {
    const validated = validateCreateTicketInput({
      projectId: ' greenfield ',
      title: ' First ticket ',
      description: '  Plan before Git.  ',
      priority: 'high',
      labels: [' api ', 'api', '', 'design'],
      assignees: ['satoshi', ' satoshi '],
    }).unwrap();

    expect(validated).toEqual({
      projectId: 'greenfield',
      title: 'First ticket',
      description: 'Plan before Git.',
      priority: 'high',
      labels: ['api', 'design'],
      assignees: ['satoshi'],
    });
    expect(normalizeStringSet(['z', 'a', 'z'])).toEqual(['a', 'z']);
  });

  test('rejects invalid content, revisions, bindings, and self-relationships', () => {
    const create = validateCreateTicketInput({
      projectId: 'project',
      title: ' ',
      description: '',
    });
    if (create.isOk()) throw new Error('Expected invalid ticket title');
    expect(create.error.kind).toBe(TicketErrorKind.InvalidInput);

    const update = validateUpdateTicketInput({ expectedRevision: 0 });
    if (update.isOk()) throw new Error('Expected invalid revision');
    expect(update.error.kind).toBe(TicketErrorKind.InvalidInput);

    const binding = validateTicketBinding({
      kind: 'github',
      owner: '',
      repository: 'kouro',
      issueNumber: 1,
      externalUrl: 'https://example.test/1',
    });
    if (binding.isOk()) throw new Error('Expected invalid provider binding');
    expect(binding.error.kind).toBe(TicketErrorKind.InvalidInput);

    const relationship = validateRelationship({
      sourceTicketId: 'ticket-1',
      targetTicketId: 'ticket-1',
      kind: 'related',
    });
    if (relationship.isOk()) throw new Error('Expected invalid self-relationship');
    expect(relationship.error.kind).toBe(TicketErrorKind.RelationshipConflict);
  });
});
