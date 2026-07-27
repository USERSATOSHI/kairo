import { describe, expect, test } from 'bun:test';

import { decideActiveRunTicketChange, deriveTicketBoardColumn, type Ticket } from '@kouro/tickets';

const ticket: Ticket = {
  id: 'ticket-1',
  projectId: 'project-1',
  title: 'Implement tickets',
  description: '',
  status: 'ready',
  labels: [],
  assignees: [],
  binding: { kind: 'local' },
  revision: 1,
  createdAt: '2026-07-26T00:00:00.000Z',
  updatedAt: '2026-07-26T00:00:00.000Z',
};

describe('T2 ticket-run policy', () => {
  test('derives execution columns without mutating planning state', () => {
    expect(
      deriveTicketBoardColumn(ticket, {
        runId: 'run-1',
        active: true,
        column: 'validating',
      }),
    ).toBe('validating');
    expect(deriveTicketBoardColumn(ticket, undefined)).toBe('ready');
    expect(ticket.status).toBe('ready');
  });

  test('maps ticket changes to explicit application commands', () => {
    expect(decideActiveRunTicketChange('title')).toEqual({
      policy: 'pause_for_review',
      command: 'pause',
    });
    expect(decideActiveRunTicketChange('comment')).toEqual({
      policy: 'notify_only',
      command: 'notify',
    });
    expect(decideActiveRunTicketChange('labels', 'cancel_and_replan')).toEqual({
      policy: 'cancel_and_replan',
      command: 'cancel',
    });
  });
});
