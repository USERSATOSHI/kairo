import { describe, expect, test } from 'bun:test';

import type { RunEvent } from '@kouro/domain';
import { reduceRun, scheduleRun } from '@kouro/runtime';
import { compileOrThrow, workflowSource } from './fixtures.ts';

describe('ADR-0004: explicit loop counters', () => {
  test('repair traversal increments while attempts do not', () => {
    const artifact = compileOrThrow(
      workflowSource({
        entryNodeId: 'test',
        nodes: [
          {
            id: 'test',
            type: 'command',
            command: 'bun test',
            recoveryPolicy: 'replay_safe',
          },
          {
            id: 'repair',
            type: 'command',
            command: 'bun run repair',
            recoveryPolicy: 'replay_safe',
          },
          { id: 'complete', type: 'complete' },
        ],
        counterLimits: { testRepair: 2 },
        transitions: [
          {
            id: 'repair.success.test',
            from: { nodeId: 'repair', outcome: 'success' },
            toNodeId: 'test',
          },
          {
            id: 'test.failed.complete',
            from: { nodeId: 'test', outcome: 'failed' },
            toNodeId: 'complete',
            condition: {
              op: 'gte',
              left: {
                scope: 'counter',
                name: 'testRepair',
              },
              right: 2,
            },
          },
          {
            id: 'test.failed.repair',
            from: { nodeId: 'test', outcome: 'failed' },
            toNodeId: 'repair',
            increment: 'testRepair',
            condition: {
              op: 'lt',
              left: {
                scope: 'counter',
                name: 'testRepair',
              },
              right: 2,
            },
          },
        ],
      }),
    );

    const events: RunEvent[] = [
      {
        sequence: 1,
        type: 'run.created',
        workflowChecksum: artifact.checksum,
        startingCommit: '0123456789abcdef',
        configuration: {},
      },
      {
        sequence: 2,
        type: 'invocation.activated',
        invocationSequence: 1,
        nodeId: 'test',
      },
      {
        sequence: 3,
        type: 'attempt.started',
        invocationSequence: 1,
        attemptNumber: 1,
      },
      {
        sequence: 4,
        type: 'attempt.interrupted',
        invocationSequence: 1,
        attemptNumber: 1,
      },
      {
        sequence: 5,
        type: 'attempt.started',
        invocationSequence: 1,
        attemptNumber: 2,
      },
      {
        sequence: 6,
        type: 'invocation.completed',
        invocationSequence: 1,
        outcome: 'failed',
      },
      {
        sequence: 7,
        type: 'invocation.activated',
        invocationSequence: 2,
        nodeId: 'repair',
        sourceInvocationSequence: 1,
        transitionId: 'test.failed.repair',
      },
      {
        sequence: 8,
        type: 'attempt.started',
        invocationSequence: 2,
        attemptNumber: 1,
      },
      {
        sequence: 9,
        type: 'invocation.completed',
        invocationSequence: 2,
        outcome: 'success',
      },
      {
        sequence: 10,
        type: 'invocation.activated',
        invocationSequence: 3,
        nodeId: 'test',
        sourceInvocationSequence: 2,
        transitionId: 'repair.success.test',
      },
      {
        sequence: 11,
        type: 'attempt.started',
        invocationSequence: 3,
        attemptNumber: 1,
      },
      {
        sequence: 12,
        type: 'invocation.completed',
        invocationSequence: 3,
        outcome: 'failed',
      },
      {
        sequence: 13,
        type: 'invocation.activated',
        invocationSequence: 4,
        nodeId: 'repair',
        sourceInvocationSequence: 3,
        transitionId: 'test.failed.repair',
      },
      {
        sequence: 14,
        type: 'attempt.started',
        invocationSequence: 4,
        attemptNumber: 1,
      },
      {
        sequence: 15,
        type: 'invocation.completed',
        invocationSequence: 4,
        outcome: 'success',
      },
      {
        sequence: 16,
        type: 'invocation.activated',
        invocationSequence: 5,
        nodeId: 'test',
        sourceInvocationSequence: 4,
        transitionId: 'repair.success.test',
      },
      {
        sequence: 17,
        type: 'attempt.started',
        invocationSequence: 5,
        attemptNumber: 1,
      },
      {
        sequence: 18,
        type: 'invocation.completed',
        invocationSequence: 5,
        outcome: 'failed',
      },
    ];

    const state = reduceRun(artifact, events);
    expect(state.isOk()).toBe(true);
    if (state.isErr()) return;

    expect(state.unwrap().counters.testRepair).toBe(2);
    expect(state.unwrap().invocations[0]?.attempts).toHaveLength(2);

    const scheduled = scheduleRun(artifact, state.unwrap());
    expect(scheduled.isOk()).toBe(true);
    if (scheduled.isOk()) {
      expect(scheduled.unwrap()).toEqual([
        {
          type: 'invocation.activate',
          nodeId: 'complete',
          invocationSequence: 6,
          sourceInvocationSequence: 5,
          transitionId: 'test.failed.complete',
        },
      ]);
    }
  });
});
