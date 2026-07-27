import { describe, expect, test } from 'bun:test';

import type { ApprovalBinding, RunEvent } from '@kouro/domain';
import { reduceRun, RuntimeErrorKind, scheduleRun } from '@kouro/runtime';
import { compileOrThrow, workflowSource } from './fixtures.ts';

const startingCommit = '0123456789abcdef';

function artifact() {
  return compileOrThrow(
    workflowSource({
      entryNodeId: 'prepare',
      nodes: [
        {
          id: 'prepare',
          type: 'command',
          command: 'bun run prepare',
          recoveryPolicy: 'replay_safe',
        },
        {
          id: 'approve',
          type: 'approval',
          title: 'Approve validation',
        },
        {
          id: 'validate',
          type: 'command',
          command: 'bun test',
          recoveryPolicy: 'replay_safe',
        },
        { id: 'complete', type: 'complete' },
      ],
      transitions: [
        {
          id: 'prepare.success.approve',
          from: { nodeId: 'prepare', outcome: 'success' },
          toNodeId: 'approve',
        },
        {
          id: 'approve.approved.validate',
          from: { nodeId: 'approve', outcome: 'approved' },
          toNodeId: 'validate',
        },
        {
          id: 'validate.passed.complete',
          from: { nodeId: 'validate', outcome: 'passed' },
          toNodeId: 'complete',
        },
      ],
    }),
  );
}

function project(compiled: ReturnType<typeof artifact>, events: readonly RunEvent[]) {
  const reduced = reduceRun(compiled, events);
  if (reduced.isErr()) {
    throw new Error(JSON.stringify(reduced.error));
  }
  return reduced.unwrap();
}

describe('M1 command → approval → command walking skeleton', () => {
  test('reaches completion through deterministic intents', () => {
    const compiled = artifact();
    const binding: ApprovalBinding = {
      workflowChecksum: compiled.checksum,
      invocationSequence: 2,
      artifactChecksums: [],
      resolvedAction: 'Approve validation',
      repositoryHead: startingCommit,
    };
    const events: RunEvent[] = [
      {
        sequence: 1,
        type: 'run.created',
        workflowChecksum: compiled.checksum,
        startingCommit,
        configuration: { profile: 'test' },
      },
    ];

    expect(scheduleRun(compiled, project(compiled, events)).unwrap()).toEqual([
      {
        type: 'invocation.activate',
        nodeId: 'prepare',
        invocationSequence: 1,
      },
    ]);

    events.push(
      {
        sequence: 2,
        type: 'invocation.activated',
        invocationSequence: 1,
        nodeId: 'prepare',
      },
      {
        sequence: 3,
        type: 'attempt.started',
        invocationSequence: 1,
        attemptNumber: 1,
      },
      {
        sequence: 4,
        type: 'invocation.completed',
        invocationSequence: 1,
        outcome: 'success',
      },
    );
    expect(scheduleRun(compiled, project(compiled, events)).unwrap()).toEqual([
      {
        type: 'invocation.activate',
        nodeId: 'approve',
        invocationSequence: 2,
        sourceInvocationSequence: 1,
        transitionId: 'prepare.success.approve',
      },
    ]);

    events.push({
      sequence: 5,
      type: 'invocation.activated',
      invocationSequence: 2,
      nodeId: 'approve',
      sourceInvocationSequence: 1,
      transitionId: 'prepare.success.approve',
    });
    expect(scheduleRun(compiled, project(compiled, events)).unwrap()).toEqual([
      {
        type: 'approval.request',
        invocationSequence: 2,
        binding,
      },
    ]);

    events.push({
      sequence: 6,
      type: 'approval.requested',
      binding,
    });
    const waiting = project(compiled, events);
    expect(waiting.status).toBe('waiting_for_approval');
    expect(scheduleRun(compiled, waiting).unwrap()).toEqual([]);

    events.push({
      sequence: 7,
      type: 'approval.granted',
      binding,
      actor: 'user:1',
      reason: 'Plan is safe',
    });
    expect(scheduleRun(compiled, project(compiled, events)).unwrap()).toEqual([
      {
        type: 'invocation.activate',
        nodeId: 'validate',
        invocationSequence: 3,
        sourceInvocationSequence: 2,
        transitionId: 'approve.approved.validate',
      },
    ]);

    events.push(
      {
        sequence: 8,
        type: 'invocation.activated',
        invocationSequence: 3,
        nodeId: 'validate',
        sourceInvocationSequence: 2,
        transitionId: 'approve.approved.validate',
      },
      {
        sequence: 9,
        type: 'attempt.started',
        invocationSequence: 3,
        attemptNumber: 1,
      },
      {
        sequence: 10,
        type: 'invocation.completed',
        invocationSequence: 3,
        outcome: 'passed',
      },
    );
    expect(scheduleRun(compiled, project(compiled, events)).unwrap()).toEqual([
      {
        type: 'invocation.activate',
        nodeId: 'complete',
        invocationSequence: 4,
        sourceInvocationSequence: 3,
        transitionId: 'validate.passed.complete',
      },
    ]);

    events.push({
      sequence: 11,
      type: 'invocation.activated',
      invocationSequence: 4,
      nodeId: 'complete',
      sourceInvocationSequence: 3,
      transitionId: 'validate.passed.complete',
    });
    expect(scheduleRun(compiled, project(compiled, events)).unwrap()).toEqual([
      { type: 'run.complete', result: 'succeeded' },
    ]);

    events.push({
      sequence: 12,
      type: 'run.completed',
      result: 'succeeded',
    });
    const completed = project(compiled, events);
    expect(completed.status).toBe('succeeded');
    expect(completed.startingCommit).toBe(startingCommit);
    expect(completed.configuration).toEqual({ profile: 'test' });
    expect(scheduleRun(compiled, completed).unwrap()).toEqual([]);
  });

  test('rejects an approval bound to stale repository state', () => {
    const compiled = artifact();
    const correctBinding: ApprovalBinding = {
      workflowChecksum: compiled.checksum,
      invocationSequence: 2,
      artifactChecksums: [],
      resolvedAction: 'Approve validation',
      repositoryHead: startingCommit,
    };
    const events: RunEvent[] = [
      {
        sequence: 1,
        type: 'run.created',
        workflowChecksum: compiled.checksum,
        startingCommit,
        configuration: {},
      },
      {
        sequence: 2,
        type: 'invocation.activated',
        invocationSequence: 1,
        nodeId: 'prepare',
      },
      {
        sequence: 3,
        type: 'attempt.started',
        invocationSequence: 1,
        attemptNumber: 1,
      },
      {
        sequence: 4,
        type: 'invocation.completed',
        invocationSequence: 1,
        outcome: 'success',
      },
      {
        sequence: 5,
        type: 'invocation.activated',
        invocationSequence: 2,
        nodeId: 'approve',
        sourceInvocationSequence: 1,
        transitionId: 'prepare.success.approve',
      },
      {
        sequence: 6,
        type: 'approval.requested',
        binding: correctBinding,
      },
      {
        sequence: 7,
        type: 'approval.granted',
        binding: {
          ...correctBinding,
          repositoryHead: 'different-head',
        },
        actor: 'user:1',
        reason: 'Approve',
      },
    ];

    const reduced = reduceRun(compiled, events);
    expect(reduced.isErr()).toBe(true);
    if (reduced.isErr()) {
      expect(reduced.error.kind).toBe(RuntimeErrorKind.StaleApproval);
    }
  });
});
