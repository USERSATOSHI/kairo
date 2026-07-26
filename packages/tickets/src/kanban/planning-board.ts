import type { Ticket, TicketStatus } from '../domain/types.ts';

export type PlanningTicketBoardColumn = 'backlog' | 'ready' | 'blocked' | 'done' | 'cancelled';

const allowedMoves: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  backlog: ['ready', 'blocked'],
  ready: ['backlog', 'blocked'],
  blocked: ['ready'],
  done: ['ready'],
  cancelled: [],
};

export function derivePlanningColumn(ticket: Readonly<Ticket>): PlanningTicketBoardColumn {
  return ticket.status;
}

export function canMovePlanningTicket(from: TicketStatus, to: TicketStatus): boolean {
  return allowedMoves[from].includes(to);
}
