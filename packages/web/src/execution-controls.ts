import type { RunDetails } from '@kouro/api-contracts';

export interface InvocationControlAvailability {
  readonly steerable: boolean;
  readonly interruptible: boolean;
  readonly retryable: boolean;
  readonly skippable: boolean;
}

export function preferredInvocationSequence(
  run: RunDetails,
  selectedNodeId: string | null,
): number | null {
  const selectedNodeInvocations = run.state.invocations.filter(
    ({ nodeId }) => nodeId === selectedNodeId,
  );
  const selectedActive = selectedNodeInvocations
    .toReversed()
    .find(({ state }) => state === 'active');
  const runActive = run.state.invocations.toReversed().find(({ state }) => state === 'active');
  return (
    selectedActive?.sequence ??
    selectedNodeInvocations.at(-1)?.sequence ??
    runActive?.sequence ??
    run.state.invocations.at(-1)?.sequence ??
    null
  );
}

export function invocationControlAvailability(
  run: RunDetails,
  invocationSequence: number,
): InvocationControlAvailability {
  const invocation = run.state.invocations.find(({ sequence }) => sequence === invocationSequence);
  const node = run.nodes.find(({ id }) => id === invocation?.nodeId);
  const attempt = invocation?.attempts.at(-1);
  const activeAttempt = invocation?.state === 'active' && attempt?.state === 'running';
  return {
    steerable: activeAttempt && node?.type === 'agent',
    interruptible: activeAttempt,
    retryable: invocation?.state === 'interrupted' && node?.recoveryPolicy === 'replay_safe',
    skippable:
      node?.skipOutcome !== undefined &&
      invocation !== undefined &&
      ['pending', 'interrupted', 'waiting_for_approval'].includes(invocation.state),
  };
}
