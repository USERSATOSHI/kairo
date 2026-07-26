import type { NodeDefinition, RunState } from '@kairo/domain';
import type { ObservableRunStore } from './ports.ts';
import type { TicketError, TicketRunQuery, TicketRunView } from '@kairo/tickets';
import { TicketErrorKind, toTicketError } from '@kairo/tickets';
import { ok, type Result } from '@usersatoshi/results';

function runningColumn(
  state: RunState,
  definitions: readonly NodeDefinition[],
): TicketRunView['column'] {
  const invocation = state.invocations
    .toReversed()
    .find(({ state: value }) => ['active', 'waiting_for_approval'].includes(value));
  const definition = definitions.find(({ id }) => id === invocation?.nodeId);
  const identity = `${definition?.id ?? ''} ${definition?.title ?? ''}`.toLowerCase();
  if (state.status === 'waiting_for_approval') {
    return identity.includes('delivery')
      ? 'waiting_for_delivery_approval'
      : 'waiting_for_plan_approval';
  }
  if (identity.includes('review')) return 'reviewing';
  if (identity.includes('repair')) return 'repairing';
  if (identity.includes('validat') || identity.includes('test')) return 'validating';
  if (identity.includes('plan')) return 'planning';
  return 'implementing';
}

export class KairoTicketRunQuery implements TicketRunQuery {
  constructor(private readonly runs: ObservableRunStore) {}

  get(runId: string): Result<TicketRunView | undefined, TicketError> {
    const loaded = this.runs.loadRun(runId);
    if (loaded.isErr()) {
      if ('runId' in loaded.error && loaded.error.runId === runId) return ok(undefined);
      return toTicketError(TicketErrorKind.DatabaseFailure, {
        operation: 'getTicketRun',
        message: 'Kairo run state could not be read',
      });
    }
    const aggregate = loaded.unwrap();
    const status = aggregate.state.status;
    return ok({
      runId,
      active: !['succeeded', 'failed', 'cancelled'].includes(status),
      column:
        status === 'succeeded'
          ? 'done'
          : status === 'failed'
            ? 'failed'
            : status === 'cancelled'
              ? 'cancelled'
              : status === 'paused'
                ? 'blocked'
                : runningColumn(aggregate.state, aggregate.artifact.bundle.nodes),
    });
  }
}
