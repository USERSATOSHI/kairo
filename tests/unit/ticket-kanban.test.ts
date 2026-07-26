import { describe, expect, test } from 'bun:test';

import {
  canMovePlanningTicket,
  derivePlanningColumn,
  type Ticket,
  type TicketStatus,
} from '@kairo/tickets';

function ticket(status: TicketStatus): Ticket {
  return {
    id: 'ticket-1',
    projectId: 'project-1',
    title: 'Plan locally',
    description: '',
    status,
    labels: [],
    assignees: [],
    binding: { kind: 'local' },
    revision: 1,
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
  };
}

describe('planning Kanban projection', () => {
  test('derives its column from planning state only', () => {
    expect(derivePlanningColumn(ticket('backlog'))).toBe('backlog');
    expect(derivePlanningColumn(ticket('blocked'))).toBe('blocked');
    expect(derivePlanningColumn(ticket('done'))).toBe('done');
  });

  test('allows only declared planning moves', () => {
    expect(canMovePlanningTicket('backlog', 'ready')).toBe(true);
    expect(canMovePlanningTicket('ready', 'backlog')).toBe(true);
    expect(canMovePlanningTicket('ready', 'blocked')).toBe(true);
    expect(canMovePlanningTicket('blocked', 'ready')).toBe(true);
    expect(canMovePlanningTicket('done', 'ready')).toBe(true);

    expect(canMovePlanningTicket('backlog', 'done')).toBe(false);
    expect(canMovePlanningTicket('blocked', 'done')).toBe(false);
    expect(canMovePlanningTicket('cancelled', 'ready')).toBe(false);
  });
});
