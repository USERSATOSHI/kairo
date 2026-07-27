import { describe, expect, test } from 'bun:test';

import type { NodeInvocation, RunState, SourceTransition } from '@kouro/domain';
import { reduceRun, RuntimeErrorKind, selectTransition } from '@kouro/runtime';
import { compileOrThrow, workflowSource } from './fixtures.ts';

const invocation: NodeInvocation = {
  sequence: 1,
  nodeId: 'command',
  state: 'succeeded',
  attempts: [{ number: 1, state: 'succeeded' }],
  outcome: 'failed',
  output: { exitCode: 1 },
};

function state(): RunState {
  return {
    workflowChecksum: 'sha256:test',
    startingCommit: '0123456789abcdef',
    repositoryHead: '0123456789abcdef',
    configuration: {},
    status: 'running',
    nextInvocationSequence: 2,
    counters: {},
    invocations: [invocation],
  };
}

function bundle(transitions: readonly SourceTransition[]) {
  const targetNodeIds = [...new Set(transitions.map(({ toNodeId }) => toNodeId))].toSorted();
  return compileOrThrow(
    workflowSource({
      nodes: [
        {
          id: 'command',
          type: 'command',
          command: 'bun test',
          recoveryPolicy: 'replay_safe',
        },
        ...targetNodeIds.map((id) => ({ id, type: 'complete' as const })),
      ],
      transitions,
    }),
  ).bundle;
}

describe('ADR-0003: exact transition selection', () => {
  test('one condition selects one transition', () => {
    const workflow = bundle([
      {
        id: 'failed.left',
        from: { nodeId: 'command', outcome: 'failed' },
        toNodeId: 'left',
        condition: {
          op: 'eq',
          left: { scope: 'output', path: ['exitCode'] },
          right: 1,
        },
      },
    ]);

    const result = selectTransition(workflow, state(), invocation);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.unwrap().id).toBe('failed.left');
    }
  });

  test('multiple matches fail independently of declaration order', () => {
    const transitions: SourceTransition[] = [
      {
        id: 'failed.right',
        from: { nodeId: 'command', outcome: 'failed' },
        toNodeId: 'right',
      },
      {
        id: 'failed.left',
        from: { nodeId: 'command', outcome: 'failed' },
        toNodeId: 'left',
      },
    ];
    const first = selectTransition(bundle(transitions), state(), invocation);
    const second = selectTransition(bundle(transitions.toReversed()), state(), invocation);

    expect(first.isErr()).toBe(true);
    expect(second.isErr()).toBe(true);
    if (first.isErr() && second.isErr()) {
      expect(first.error.kind).toBe(RuntimeErrorKind.AmbiguousTransition);
      expect(first.error).toEqual(second.error);
    }
  });

  test('an explicit default handles no condition match', () => {
    const workflow = bundle([
      {
        id: 'failed.conditional',
        from: { nodeId: 'command', outcome: 'failed' },
        toNodeId: 'left',
        condition: {
          op: 'eq',
          left: { scope: 'output', path: ['exitCode'] },
          right: 2,
        },
      },
      {
        id: 'failed.default',
        from: { nodeId: 'command', outcome: 'failed' },
        toNodeId: 'right',
        default: true,
      },
    ]);

    const result = selectTransition(workflow, state(), invocation);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.unwrap().id).toBe('failed.default');
    }
  });

  test('no match without a default is a typed failure', () => {
    const workflow = bundle([]);
    const result = selectTransition(workflow, state(), invocation);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe(RuntimeErrorKind.MissingTransition);
    }
  });

  test('replay rejects a transition the scheduler would not select', () => {
    const artifact = compileOrThrow(
      workflowSource({
        nodes: [
          {
            id: 'command',
            type: 'command',
            command: 'bun test',
            recoveryPolicy: 'replay_safe',
          },
          { id: 'left', type: 'complete' },
          { id: 'right', type: 'complete' },
        ],
        transitions: [
          {
            id: 'success.left',
            from: { nodeId: 'command', outcome: 'success' },
            toNodeId: 'left',
            condition: {
              op: 'eq',
              left: {
                scope: 'output',
                path: ['choice'],
              },
              right: 'left',
            },
          },
          {
            id: 'success.default',
            from: { nodeId: 'command', outcome: 'success' },
            toNodeId: 'right',
            default: true,
          },
        ],
      }),
    );
    const replayed = reduceRun(artifact, [
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
        nodeId: 'command',
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
        output: { choice: 'left' },
      },
      {
        sequence: 5,
        type: 'invocation.activated',
        invocationSequence: 2,
        nodeId: 'right',
        sourceInvocationSequence: 1,
        transitionId: 'success.default',
      },
    ]);

    expect(replayed.isErr()).toBe(true);
    if (replayed.isErr()) {
      expect(replayed.error.kind).toBe(RuntimeErrorKind.IllegalStateTransition);
    }
  });
});
