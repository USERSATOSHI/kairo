import { ok, type Result } from '@usersatoshi/results';

import type {
  CompiledWorkflowArtifact,
  NodeDefinition,
  NodeInvocation,
  OrchestrationIntent,
  RunState,
} from '@kouro/domain';
import type { RuntimeError } from './errors.ts';
import { selectTransition } from './transitions.ts';

function durationLimitReached(artifact: CompiledWorkflowArtifact, state: RunState): boolean {
  const limit = artifact.bundle.runLimits?.maxDurationMs;
  if (limit === undefined || !state.startedAt || !state.observedAt) return false;
  return Date.parse(state.observedAt) - Date.parse(state.startedAt) >= limit;
}

function activationIntent(
  artifact: CompiledWorkflowArtifact,
  intent: Extract<OrchestrationIntent, { type: 'invocation.activate' }>,
): OrchestrationIntent {
  const limit = artifact.bundle.runLimits?.maxNodeInvocations;
  return limit !== undefined && intent.invocationSequence > limit
    ? { type: 'run.complete', result: 'failed' }
    : intent;
}

function approvalArtifactChecksums(state: RunState): readonly string[] {
  return [
    ...(state.artifacts ?? []).map(({ checksum }) => checksum),
    ...state.invocations.flatMap(({ attempts }) =>
      attempts.flatMap(({ artifacts }) => artifacts?.map(({ checksum }) => checksum) ?? []),
    ),
  ].toSorted();
}

function definitionFor(
  artifact: CompiledWorkflowArtifact,
  invocation: NodeInvocation,
): NodeDefinition {
  const definition = artifact.bundle.nodes.find(({ id }) => id === invocation.nodeId);
  if (!definition) {
    throw new Error(`Projected invocation references unknown node: ${invocation.nodeId}`);
  }
  return definition;
}

function sortInvocations(
  artifact: CompiledWorkflowArtifact,
  invocations: readonly NodeInvocation[],
): NodeInvocation[] {
  return invocations.toSorted((left, right) => {
    const leftDefinition = definitionFor(artifact, left);
    const rightDefinition = definitionFor(artifact, right);
    return (
      leftDefinition.priority - rightDefinition.priority ||
      leftDefinition.ordinal - rightDefinition.ordinal ||
      left.sequence - right.sequence
    );
  });
}

function recoveryIntent(
  definition: NodeDefinition,
  invocation: NodeInvocation,
): OrchestrationIntent {
  const lastAttempt = invocation.attempts.at(-1);
  const attemptNumber = (lastAttempt?.number ?? 0) + 1;

  switch (definition.recoveryPolicy) {
    case 'replay_safe':
      return {
        type: 'attempt.schedule',
        invocationSequence: invocation.sequence,
        attemptNumber,
      };
    case 'verify_then_replay':
      return {
        type: 'effect.verify',
        invocationSequence: invocation.sequence,
        attemptNumber: lastAttempt?.number ?? 1,
      };
    case 'resume_supported':
      return lastAttempt?.resumeToken
        ? {
            type: 'session.resume',
            invocationSequence: invocation.sequence,
            token: lastAttempt.resumeToken,
          }
        : {
            type: 'reconciliation.request',
            invocationSequence: invocation.sequence,
          };
    case 'manual_reconciliation':
      return {
        type: 'reconciliation.request',
        invocationSequence: invocation.sequence,
      };
    case 'never_automatically_retry':
    default:
      return {
        type: 'recovery.halt',
        invocationSequence: invocation.sequence,
      };
  }
}

export function scheduleRun(
  artifact: CompiledWorkflowArtifact,
  state: RunState,
): Result<readonly OrchestrationIntent[], RuntimeError> {
  if (state.status !== 'running') {
    return ok([]);
  }

  if (durationLimitReached(artifact, state)) {
    return ok([{ type: 'run.complete', result: 'failed' }]);
  }

  if (state.invocations.length === 0) {
    return ok([
      activationIntent(artifact, {
        type: 'invocation.activate',
        nodeId: artifact.bundle.entryNodeId,
        invocationSequence: state.nextInvocationSequence,
      }),
    ]);
  }

  const interrupted = sortInvocations(
    artifact,
    state.invocations.filter(({ state: invocationState }) => invocationState === 'interrupted'),
  )[0];
  if (interrupted) {
    return ok([recoveryIntent(definitionFor(artifact, interrupted), interrupted)]);
  }

  if (state.invocations.some(({ state: invocationState }) => invocationState === 'failed')) {
    return ok([{ type: 'run.complete', result: 'failed' }]);
  }

  const pending = sortInvocations(
    artifact,
    state.invocations.filter(({ state: invocationState }) => invocationState === 'pending'),
  )[0];
  if (pending) {
    const definition = definitionFor(artifact, pending);
    if (definition.type === 'approval' || definition.type === 'delivery_review') {
      const proposal = state.delivery?.proposal;
      if (definition.type === 'delivery_review' && !proposal) {
        return ok([]);
      }
      return ok([
        {
          type: 'approval.request',
          invocationSequence: pending.sequence,
          binding: {
            workflowChecksum: artifact.checksum,
            invocationSequence: pending.sequence,
            artifactChecksums: approvalArtifactChecksums(state),
            resolvedAction: definition.title ?? '',
            repositoryHead: state.repositoryHead,
            ...(definition.type === 'delivery_review' && proposal
              ? {
                  preparedTree: proposal.preparedTree,
                  proposalChecksum: proposal.checksum,
                }
              : {}),
          },
        },
      ]);
    }
    if (definition.type === 'complete') {
      return ok([{ type: 'run.complete', result: definition.result ?? 'succeeded' }]);
    }
    return ok([
      {
        type: 'attempt.schedule',
        invocationSequence: pending.sequence,
        attemptNumber: pending.attempts.length + 1,
      },
    ]);
  }

  const completed = sortInvocations(
    artifact,
    state.invocations.filter(
      (invocation) => invocation.state === 'succeeded' && !invocation.selectedTransitionId,
    ),
  )[0];
  if (!completed) {
    return ok([]);
  }

  const transition = selectTransition(artifact.bundle, state, completed);
  if (transition.isErr()) {
    return transition;
  }
  const selectedTransition = transition.unwrap();

  return ok([
    activationIntent(artifact, {
      type: 'invocation.activate',
      nodeId: selectedTransition.toNodeId,
      invocationSequence: state.nextInvocationSequence,
      sourceInvocationSequence: completed.sequence,
      transitionId: selectedTransition.id,
    }),
  ]);
}
