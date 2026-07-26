import type { Ticket } from '../domain/types.ts';
import { derivePlanningColumn } from '../kanban/planning-board.ts';
import type {
  ActiveRunTicketChangePolicy,
  TicketBoardColumn,
  TicketChangeDecision,
  TicketChangeKind,
  TicketRunView,
} from './types.ts';

const defaultPolicies: Readonly<Record<TicketChangeKind, ActiveRunTicketChangePolicy>> = {
  title: 'pause_for_review',
  description: 'pause_for_review',
  acceptance_criteria: 'pause_for_review',
  labels: 'notify_only',
  assignees: 'notify_only',
  comment: 'notify_only',
  external_close: 'pause_for_review',
};

const policyCommands: Readonly<
  Record<ActiveRunTicketChangePolicy, TicketChangeDecision['command']>
> = {
  ignore_until_next_run: 'none',
  notify_only: 'notify',
  pause_for_review: 'pause',
  cancel_and_replan: 'cancel',
};

export function decideActiveRunTicketChange(
  change: TicketChangeKind,
  override?: ActiveRunTicketChangePolicy,
): TicketChangeDecision {
  const policy = override ?? defaultPolicies[change];
  return { policy, command: policyCommands[policy] };
}

export function deriveTicketBoardColumn(
  ticket: Readonly<Ticket>,
  activeRun: Readonly<TicketRunView> | undefined,
): TicketBoardColumn {
  if (activeRun?.active) return activeRun.column;
  return derivePlanningColumn(ticket);
}
