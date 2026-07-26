import { ok, type Result } from '@usersatoshi/results';

import type {
  ApprovalBinding,
  ArtifactReference,
  CompiledWorkflowArtifact,
  NodeAttempt,
  NodeInvocation,
  RunEvent,
  RunState,
  SkipBinding,
} from '@kairo/domain';
import { RuntimeErrorKind, toRuntimeError, type RuntimeError } from './errors.ts';
import { agentHarnessesForNode } from './harness-routing.ts';
import { selectTransition } from './transitions.ts';

function approvalBindingsEqual(left: ApprovalBinding, right: ApprovalBinding): boolean {
  return (
    left.workflowChecksum === right.workflowChecksum &&
    left.invocationSequence === right.invocationSequence &&
    left.resolvedAction === right.resolvedAction &&
    left.repositoryHead === right.repositoryHead &&
    left.artifactChecksums.length === right.artifactChecksums.length &&
    left.artifactChecksums.every((checksum, index) => checksum === right.artifactChecksums[index])
  );
}

function validArtifactReference(artifact: ArtifactReference): boolean {
  return (
    artifact.id.trim().length > 0 &&
    artifact.mediaType.trim().length > 0 &&
    /^sha256:[0-9a-f]{64}$/.test(artifact.checksum) &&
    Number.isSafeInteger(artifact.size) &&
    artifact.size >= 0
  );
}

function artifactChecksums(state: RunState): readonly string[] {
  return [
    ...(state.artifacts ?? []).map(({ checksum }) => checksum),
    ...state.invocations.flatMap(({ attempts }) =>
      attempts.flatMap(({ artifacts }) => artifacts?.map(({ checksum }) => checksum) ?? []),
    ),
  ].toSorted();
}

function skipBindingsEqual(left: SkipBinding, right: SkipBinding): boolean {
  return (
    left.workflowChecksum === right.workflowChecksum &&
    left.invocationSequence === right.invocationSequence &&
    left.selectedOutcome === right.selectedOutcome &&
    left.repositoryHead === right.repositoryHead &&
    left.artifactChecksums.length === right.artifactChecksums.length &&
    left.artifactChecksums.every((checksum, index) => checksum === right.artifactChecksums[index])
  );
}

function timestampMilliseconds(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const milliseconds = Date.parse(value);
  return Number.isNaN(milliseconds) || new Date(milliseconds).toISOString() !== value
    ? undefined
    : milliseconds;
}

function durationLimitReached(artifact: CompiledWorkflowArtifact, state: RunState): boolean {
  const limit = artifact.bundle.runLimits?.maxDurationMs;
  const startedAt = timestampMilliseconds(state.startedAt);
  const observedAt = timestampMilliseconds(state.observedAt);
  return (
    limit !== undefined &&
    startedAt !== undefined &&
    observedAt !== undefined &&
    observedAt - startedAt >= limit
  );
}

function replaceInvocation(
  state: RunState,
  sequence: number,
  update: (invocation: NodeInvocation) => Result<NodeInvocation, RuntimeError>,
): Result<RunState, RuntimeError> {
  const invocation = state.invocations.find((candidate) => candidate.sequence === sequence);
  if (!invocation) {
    return toRuntimeError(RuntimeErrorKind.UnknownInvocation, {
      invocationSequence: sequence,
    });
  }
  const updated = update(invocation);
  if (updated.isErr()) {
    return updated;
  }
  const updatedInvocation = updated.unwrap();
  const invocations = state.invocations.map((candidate) =>
    candidate.sequence === sequence ? updatedInvocation : candidate,
  );
  return ok({ ...state, invocations });
}

function reduceEvent(
  artifact: CompiledWorkflowArtifact,
  state: RunState | undefined,
  event: RunEvent,
): Result<RunState, RuntimeError> {
  if (event.type === 'run.created') {
    if (event.workflowChecksum !== artifact.checksum) {
      return toRuntimeError(RuntimeErrorKind.WorkflowChecksumMismatch, {
        expected: artifact.checksum,
        received: event.workflowChecksum,
      });
    }
    if (state) {
      return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
        entity: 'run',
        from: state.status,
        event: event.type,
      });
    }
    if (event.startedAt !== undefined && timestampMilliseconds(event.startedAt) === undefined) {
      return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
        entity: 'run-clock',
        from: 'uninitialized',
        event: event.type,
      });
    }
    return ok({
      workflowChecksum: artifact.checksum,
      startingCommit: event.startingCommit,
      repositoryHead: event.startingCommit,
      configuration: event.configuration,
      ...(event.startedAt === undefined
        ? {}
        : { startedAt: event.startedAt, observedAt: event.startedAt }),
      status: 'running',
      nextInvocationSequence: 1,
      counters: Object.fromEntries(
        Object.keys(artifact.bundle.counterLimits)
          .toSorted()
          .map((counter) => [counter, 0]),
      ),
      invocations: [],
    });
  }

  if (!state) {
    return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
      entity: 'run',
      from: 'uninitialized',
      event: event.type,
    });
  }

  if (state.status === 'succeeded' || state.status === 'failed' || state.status === 'cancelled') {
    return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
      entity: 'run',
      from: state.status,
      event: event.type,
    });
  }

  if (event.type === 'run.time_observed') {
    const observedAt = timestampMilliseconds(event.observedAt);
    const previous = timestampMilliseconds(state.observedAt ?? state.startedAt);
    if (
      state.status !== 'running' ||
      observedAt === undefined ||
      (previous !== undefined && observedAt < previous)
    ) {
      return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
        entity: 'run-clock',
        from: state.status,
        event: event.type,
      });
    }
    return ok({ ...state, observedAt: event.observedAt });
  }

  if (event.type === 'run.paused') {
    if (
      !event.actor.trim() ||
      (state.status !== 'running' && state.status !== 'waiting_for_approval')
    ) {
      return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
        entity: 'run',
        from: state.status,
        event: event.type,
      });
    }
    return ok({ ...state, status: 'paused' });
  }

  if (event.type === 'run.resumed') {
    if (state.status !== 'paused' || !event.actor.trim()) {
      return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
        entity: 'run',
        from: state.status,
        event: event.type,
      });
    }
    const waiting = state.invocations.some(
      ({ state: invocationState }) => invocationState === 'waiting_for_approval',
    );
    return ok({ ...state, status: waiting ? 'waiting_for_approval' : 'running' });
  }

  if (event.type === 'run.cancelled') {
    if (!event.actor.trim() || !event.reason.trim()) {
      return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
        entity: 'run',
        from: state.status,
        event: event.type,
      });
    }
    return ok({
      ...state,
      status: 'cancelled',
      invocations: state.invocations.map((invocation) =>
        ['succeeded', 'failed', 'cancelled'].includes(invocation.state)
          ? invocation
          : {
              ...invocation,
              state: 'cancelled',
              attempts: invocation.attempts.map((attempt) =>
                attempt.state === 'running' ? { ...attempt, state: 'cancelled' } : attempt,
              ),
            },
      ),
    });
  }

  if (
    state.status === 'waiting_for_approval' &&
    event.type !== 'approval.granted' &&
    event.type !== 'approval.rejected' &&
    event.type !== 'invocation.skipped'
  ) {
    return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
      entity: 'run',
      from: state.status,
      event: event.type,
    });
  }

  if (event.type === 'invocation.activated') {
    if (state.status !== 'running') {
      return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
        entity: 'run',
        from: state.status,
        event: event.type,
      });
    }
    if (event.invocationSequence !== state.nextInvocationSequence) {
      return toRuntimeError(RuntimeErrorKind.InvalidInvocationSequence, {
        expected: state.nextInvocationSequence,
        received: event.invocationSequence,
      });
    }
    if (!artifact.bundle.nodes.some(({ id }) => id === event.nodeId)) {
      return toRuntimeError(RuntimeErrorKind.UnknownNode, {
        nodeId: event.nodeId,
      });
    }

    let counters = state.counters;
    let invocations = state.invocations;
    if (event.transitionId === undefined) {
      if (
        state.invocations.length !== 0 ||
        event.nodeId !== artifact.bundle.entryNodeId ||
        event.sourceInvocationSequence !== undefined
      ) {
        return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
          entity: 'invocation',
          from: state.status,
          event: event.type,
        });
      }
    } else {
      const transition = artifact.bundle.transitions.find(({ id }) => id === event.transitionId);
      const source =
        event.sourceInvocationSequence === undefined
          ? undefined
          : state.invocations.find(({ sequence }) => sequence === event.sourceInvocationSequence);
      if (
        !transition ||
        !source ||
        source.selectedTransitionId ||
        transition.from.nodeId !== source.nodeId ||
        transition.from.outcome !== source.outcome ||
        transition.toNodeId !== event.nodeId
      ) {
        return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
          entity: 'transition',
          from: source?.state ?? 'unknown',
          event: event.type,
        });
      }
      const selected = selectTransition(artifact.bundle, state, source);
      if (selected.isErr()) {
        return selected;
      }
      if (selected.unwrap().id !== transition.id) {
        return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
          entity: 'transition',
          from: source.state,
          event: event.type,
        });
      }
      if (transition.increment) {
        const current = counters[transition.increment];
        if (current === undefined) {
          return toRuntimeError(RuntimeErrorKind.UnknownCounter, {
            counter: transition.increment,
          });
        }
        counters = {
          ...counters,
          [transition.increment]: current + 1,
        };
      }
      invocations = invocations.map((invocation) =>
        invocation.sequence === source.sequence
          ? { ...invocation, selectedTransitionId: transition.id }
          : invocation,
      );
    }

    return ok({
      ...state,
      counters,
      invocations: [
        ...invocations,
        {
          sequence: event.invocationSequence,
          nodeId: event.nodeId,
          state: 'pending',
          attempts: [],
        },
      ],
      nextInvocationSequence: state.nextInvocationSequence + 1,
    });
  }

  if (event.type === 'attempt.started') {
    return replaceInvocation(state, event.invocationSequence, (invocation) => {
      const expected = invocation.attempts.length + 1;
      const definition = artifact.bundle.nodes.find(({ id }) => id === invocation.nodeId);
      if (definition?.type !== 'agent' && definition?.type !== 'command') {
        return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
          entity: `invocation:${invocation.sequence}`,
          from: invocation.state,
          event: event.type,
        });
      }
      if (
        event.attemptNumber !== expected ||
        !['pending', 'interrupted'].includes(invocation.state) ||
        (invocation.state === 'interrupted' && definition?.recoveryPolicy !== 'replay_safe')
      ) {
        return toRuntimeError(RuntimeErrorKind.InvalidAttemptNumber, {
          invocationSequence: invocation.sequence,
          expected,
          received: event.attemptNumber,
        });
      }
      if (definition.type === 'agent') {
        const expectedHarness = agentHarnessesForNode(
          state.configuration,
          definition.id,
          definition.harness,
        )?.[event.attemptNumber - 1];
        const expectedModel = expectedHarness ? definition.models?.[expectedHarness] : undefined;
        if (
          !expectedHarness ||
          event.harnessId !== expectedHarness ||
          event.model !== expectedModel
        ) {
          return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
            entity: `attempt:${event.attemptNumber}`,
            from: invocation.state,
            event: 'attempt.started:execution_selection_mismatch',
          });
        }
      } else if (event.harnessId !== undefined || event.model !== undefined) {
        return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
          entity: `attempt:${event.attemptNumber}`,
          from: invocation.state,
          event: 'attempt.started:unexpected_agent_selection',
        });
      }
      const attempt: NodeAttempt = {
        number: event.attemptNumber,
        state: 'running',
        ...(event.harnessId ? { harnessId: event.harnessId } : {}),
        ...(event.model ? { model: event.model } : {}),
        ...(event.resumeToken ? { resumeToken: event.resumeToken } : {}),
      };
      return ok({
        ...invocation,
        state: 'active',
        attempts: [...invocation.attempts, attempt],
      });
    });
  }

  if (event.type === 'attempt.resumed') {
    return replaceInvocation(state, event.invocationSequence, (invocation) => {
      const attempt = invocation.attempts.at(-1);
      const definition = artifact.bundle.nodes.find(({ id }) => id === invocation.nodeId);
      if (
        definition?.type !== 'agent' ||
        invocation.state !== 'interrupted' ||
        !attempt ||
        attempt.number !== event.attemptNumber ||
        attempt.resumeToken !== event.resumeToken ||
        attempt.harnessId !== event.harnessId
      ) {
        return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
          entity: `attempt:${event.attemptNumber}`,
          from: invocation.state,
          event: event.type,
        });
      }
      return ok({
        ...invocation,
        state: 'active',
        attempts: invocation.attempts.map((candidate) =>
          candidate.number === attempt.number ? { ...candidate, state: 'running' } : candidate,
        ),
      });
    });
  }

  if (event.type === 'attempt.resume_token_recorded') {
    return replaceInvocation(state, event.invocationSequence, (invocation) => {
      const attempt = invocation.attempts.at(-1);
      const definition = artifact.bundle.nodes.find(({ id }) => id === invocation.nodeId);
      if (
        definition?.type !== 'agent' ||
        invocation.state !== 'active' ||
        !attempt ||
        attempt.number !== event.attemptNumber ||
        attempt.resumeToken !== undefined ||
        !event.resumeToken.trim()
      ) {
        return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
          entity: `attempt:${event.attemptNumber}`,
          from: invocation.state,
          event: event.type,
        });
      }
      return ok({
        ...invocation,
        attempts: invocation.attempts.map((candidate) =>
          candidate.number === attempt.number
            ? { ...candidate, resumeToken: event.resumeToken }
            : candidate,
        ),
      });
    });
  }

  if (event.type === 'attempt.artifact_published') {
    return replaceInvocation(state, event.invocationSequence, (invocation) => {
      const attempt = invocation.attempts.at(-1);
      const definition = artifact.bundle.nodes.find(({ id }) => id === invocation.nodeId);
      if (
        definition?.type !== 'agent' ||
        invocation.state !== 'active' ||
        !attempt ||
        attempt.number !== event.attemptNumber ||
        !validArtifactReference(event.artifact) ||
        attempt.artifacts?.some(({ id }) => id === event.artifact.id)
      ) {
        return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
          entity: `attempt:${event.attemptNumber}`,
          from: invocation.state,
          event: event.type,
        });
      }
      return ok({
        ...invocation,
        attempts: invocation.attempts.map((candidate) =>
          candidate.number === attempt.number
            ? { ...candidate, artifacts: [...(candidate.artifacts ?? []), event.artifact] }
            : candidate,
        ),
      });
    });
  }

  if (event.type === 'run.artifact_published') {
    if (
      !validArtifactReference(event.artifact) ||
      state.artifacts?.some(({ id }) => id === event.artifact.id)
    ) {
      return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
        entity: 'run-artifact',
        from: state.status,
        event: event.type,
      });
    }
    return ok({ ...state, artifacts: [...(state.artifacts ?? []), event.artifact] });
  }

  if (event.type === 'attempt.failed') {
    return replaceInvocation(state, event.invocationSequence, (invocation) => {
      const attempt = invocation.attempts.at(-1);
      const definition = artifact.bundle.nodes.find(({ id }) => id === invocation.nodeId);
      const fallbackExists =
        definition?.type === 'agent' &&
        typeof agentHarnessesForNode(state.configuration, definition.id, definition.harness)?.[
          event.attemptNumber
        ] === 'string';
      if (
        definition?.type !== 'agent' ||
        invocation.state !== 'active' ||
        !attempt ||
        attempt.number !== event.attemptNumber ||
        !event.failure.kind.trim() ||
        !event.failure.message.trim() ||
        (event.retry === 'fallback' && !fallbackExists)
      ) {
        return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
          entity: `attempt:${event.attemptNumber}`,
          from: invocation.state,
          event: event.type,
        });
      }
      return ok({
        ...invocation,
        state: event.retry === 'fallback' ? 'pending' : 'failed',
        attempts: invocation.attempts.map((candidate) =>
          candidate.number === attempt.number
            ? { ...candidate, state: 'failed', failure: event.failure }
            : candidate,
        ),
      });
    });
  }

  if (event.type === 'attempt.interrupted' || event.type === 'attempt.interrupt_requested') {
    return replaceInvocation(state, event.invocationSequence, (invocation) => {
      const attempt = invocation.attempts.at(-1);
      if (
        invocation.state !== 'active' ||
        !attempt ||
        attempt.number !== event.attemptNumber ||
        (event.type === 'attempt.interrupt_requested' &&
          (!event.actor.trim() || !event.reason.trim()))
      ) {
        return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
          entity: `attempt:${event.attemptNumber}`,
          from: invocation.state,
          event: event.type,
        });
      }
      return ok({
        ...invocation,
        state: 'interrupted',
        attempts: invocation.attempts.map((candidate) =>
          candidate.number === attempt.number ? { ...candidate, state: 'interrupted' } : candidate,
        ),
      });
    });
  }

  if (event.type === 'invocation.retry_requested') {
    return replaceInvocation(state, event.invocationSequence, (invocation) => {
      const definition = artifact.bundle.nodes.find(({ id }) => id === invocation.nodeId);
      if (
        invocation.state !== 'interrupted' ||
        definition?.recoveryPolicy !== 'replay_safe' ||
        !event.actor.trim() ||
        !event.reason.trim()
      ) {
        return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
          entity: `invocation:${invocation.sequence}`,
          from: invocation.state,
          event: event.type,
        });
      }
      return ok({ ...invocation, state: 'pending' });
    });
  }

  if (event.type === 'invocation.skipped') {
    const invocation = state.invocations.find(
      ({ sequence }) => sequence === event.binding.invocationSequence,
    );
    if (!invocation) {
      return toRuntimeError(RuntimeErrorKind.UnknownInvocation, {
        invocationSequence: event.binding.invocationSequence,
      });
    }
    const definition = artifact.bundle.nodes.find(({ id }) => id === invocation.nodeId);
    const expected: SkipBinding = {
      workflowChecksum: artifact.checksum,
      invocationSequence: invocation.sequence,
      artifactChecksums: artifactChecksums(state),
      selectedOutcome: definition?.skipOutcome ?? '',
      repositoryHead: state.repositoryHead,
    };
    if (
      !['pending', 'interrupted', 'waiting_for_approval'].includes(invocation.state) ||
      !definition?.skipOutcome ||
      !event.actor.trim() ||
      !event.reason.trim() ||
      !skipBindingsEqual(event.binding, expected)
    ) {
      return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
        entity: `invocation:${invocation.sequence}`,
        from: invocation.state,
        event: event.type,
      });
    }
    const updated = replaceInvocation(state, invocation.sequence, (current) =>
      ok({
        ...current,
        state: 'succeeded',
        outcome: event.binding.selectedOutcome,
      }),
    );
    if (updated.isErr()) return updated;
    return ok({ ...updated.unwrap(), status: 'running' });
  }

  if (event.type === 'invocation.completed') {
    return replaceInvocation(state, event.invocationSequence, (invocation) => {
      const attempt = invocation.attempts.at(-1);
      const definition = artifact.bundle.nodes.find(({ id }) => id === invocation.nodeId);
      if (
        invocation.state !== 'active' ||
        !attempt ||
        (definition?.type !== 'agent' && definition?.type !== 'command')
      ) {
        return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
          entity: `invocation:${invocation.sequence}`,
          from: invocation.state,
          event: event.type,
        });
      }
      return ok({
        ...invocation,
        state: 'succeeded',
        outcome: event.outcome,
        ...(event.output !== undefined ? { output: event.output } : {}),
        attempts: invocation.attempts.map((candidate) =>
          candidate.number === attempt.number ? { ...candidate, state: 'succeeded' } : candidate,
        ),
      });
    });
  }

  if (event.type === 'approval.requested') {
    const invocation = state.invocations.find(
      ({ sequence }) => sequence === event.binding.invocationSequence,
    );
    if (!invocation) {
      return toRuntimeError(RuntimeErrorKind.UnknownInvocation, {
        invocationSequence: event.binding.invocationSequence,
      });
    }
    const definition = artifact.bundle.nodes.find(({ id }) => id === invocation.nodeId);
    const expected: ApprovalBinding = {
      workflowChecksum: artifact.checksum,
      invocationSequence: invocation.sequence,
      artifactChecksums: artifactChecksums(state),
      resolvedAction: definition?.title ?? '',
      repositoryHead: state.repositoryHead,
    };
    if (
      invocation.state !== 'pending' ||
      definition?.type !== 'approval' ||
      !approvalBindingsEqual(event.binding, expected)
    ) {
      return toRuntimeError(RuntimeErrorKind.StaleApproval, {
        invocationSequence: invocation.sequence,
        reason: 'approval request does not match projected action',
      });
    }
    const updated = replaceInvocation(state, invocation.sequence, (current) =>
      ok({
        ...current,
        state: 'waiting_for_approval',
        approval: event.binding,
      }),
    );
    if (updated.isErr()) return updated;
    return ok({
      ...updated.unwrap(),
      status: 'waiting_for_approval',
    });
  }

  if (event.type === 'approval.granted' || event.type === 'approval.rejected') {
    const invocation = state.invocations.find(
      ({ sequence }) => sequence === event.binding.invocationSequence,
    );
    if (!invocation) {
      return toRuntimeError(RuntimeErrorKind.UnknownInvocation, {
        invocationSequence: event.binding.invocationSequence,
      });
    }
    if (
      state.status !== 'waiting_for_approval' ||
      invocation.state !== 'waiting_for_approval' ||
      !invocation.approval ||
      !approvalBindingsEqual(event.binding, invocation.approval) ||
      !event.actor.trim() ||
      !event.reason.trim()
    ) {
      return toRuntimeError(RuntimeErrorKind.StaleApproval, {
        invocationSequence: invocation.sequence,
        reason: 'approval decision is stale or incomplete',
      });
    }
    const updated = replaceInvocation(state, invocation.sequence, (current) =>
      ok({
        ...current,
        state: 'succeeded',
        outcome: event.type === 'approval.granted' ? 'approved' : 'rejected',
      }),
    );
    if (updated.isErr()) return updated;
    return ok({ ...updated.unwrap(), status: 'running' });
  }

  if (event.type === 'run.completed') {
    const completeInvocation = state.invocations.find((invocation) => {
      const definition = artifact.bundle.nodes.find(({ id }) => id === invocation.nodeId);
      return invocation.state === 'pending' && definition?.type === 'complete';
    });
    const completeResult = completeInvocation
      ? (artifact.bundle.nodes.find(({ id }) => id === completeInvocation.nodeId)?.result ??
        'succeeded')
      : undefined;
    const failedInvocation = state.invocations.some(
      ({ state: invocationState }) => invocationState === 'failed',
    );
    const invocationLimitReached =
      artifact.bundle.runLimits?.maxNodeInvocations !== undefined &&
      state.nextInvocationSequence > artifact.bundle.runLimits.maxNodeInvocations &&
      state.invocations.some(
        ({ state: invocationState, selectedTransitionId }) =>
          invocationState === 'succeeded' && selectedTransitionId === undefined,
      ) &&
      !state.invocations.some(({ state: invocationState }) =>
        ['pending', 'active', 'interrupted', 'waiting_for_approval'].includes(invocationState),
      );
    const expectedTerminalResult =
      completeResult ??
      (failedInvocation || invocationLimitReached || durationLimitReached(artifact, state)
        ? 'failed'
        : undefined);
    if (state.status !== 'running' || event.result !== expectedTerminalResult) {
      return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
        entity: 'run',
        from: state.status,
        event: event.type,
      });
    }
    return ok({
      ...state,
      status: event.result,
    });
  }

  return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
    entity: 'run-event',
    from: state.status,
    event: 'unknown',
  });
}

export function reduceRun(
  artifact: CompiledWorkflowArtifact,
  events: readonly RunEvent[],
): Result<RunState, RuntimeError> {
  let state: RunState | undefined;

  let expected = 1;
  for (const event of events) {
    if (event.sequence !== expected) {
      return toRuntimeError(RuntimeErrorKind.InvalidEventSequence, {
        expected,
        received: event.sequence,
      });
    }

    const next = reduceEvent(artifact, state, event);
    if (next.isErr()) {
      return next;
    }
    state = next.unwrap();
    expected += 1;
  }

  if (!state) {
    return toRuntimeError(RuntimeErrorKind.IllegalStateTransition, {
      entity: 'run',
      from: 'uninitialized',
      event: 'history.ended',
    });
  }

  return ok(state);
}
