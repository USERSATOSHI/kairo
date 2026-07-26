import { describe, expect, test } from 'bun:test';

import type { RunEvent } from '@kairo/domain';
import { reduceRun, RuntimeErrorKind } from '@kairo/runtime';
import { compileOrThrow, workflowSource } from './fixtures.ts';

const startingCommit = '0123456789abcdef';

describe('M1 malformed durable-history rejection', () => {
  test('rejects a workflow checksum mismatch', () => {
    const artifact = compileOrThrow();
    const result = reduceRun(artifact, [
      {
        sequence: 1,
        type: 'run.created',
        workflowChecksum: 'sha256:different',
        startingCommit,
        configuration: {},
      },
    ]);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe(RuntimeErrorKind.WorkflowChecksumMismatch);
    }
  });

  test('rejects activation of a non-entry node', () => {
    const artifact = compileOrThrow();
    const result = reduceRun(artifact, [
      {
        sequence: 1,
        type: 'run.created',
        workflowChecksum: artifact.checksum,
        startingCommit,
        configuration: {},
      },
      {
        sequence: 2,
        type: 'invocation.activated',
        invocationSequence: 1,
        nodeId: 'complete',
      },
    ]);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe(RuntimeErrorKind.IllegalStateTransition);
    }
  });

  test('rejects completion before the complete node is activated', () => {
    const artifact = compileOrThrow();
    const result = reduceRun(artifact, [
      {
        sequence: 1,
        type: 'run.created',
        workflowChecksum: artifact.checksum,
        startingCommit,
        configuration: {},
      },
      {
        sequence: 2,
        type: 'run.completed',
        result: 'succeeded',
      },
    ]);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe(RuntimeErrorKind.IllegalStateTransition);
    }
  });

  test('rejects attempts that bypass an approval gate', () => {
    const artifact = compileOrThrow(
      workflowSource({
        entryNodeId: 'approval',
        nodes: [
          { id: 'approval', type: 'approval', title: 'Deploy' },
          { id: 'complete', type: 'complete' },
        ],
        transitions: [
          {
            id: 'approval.approved',
            from: { nodeId: 'approval', outcome: 'approved' },
            toNodeId: 'complete',
          },
        ],
      }),
    );
    const result = reduceRun(artifact, [
      {
        sequence: 1,
        type: 'run.created',
        workflowChecksum: artifact.checksum,
        startingCommit,
        configuration: {},
      },
      {
        sequence: 2,
        type: 'invocation.activated',
        invocationSequence: 1,
        nodeId: 'approval',
      },
      {
        sequence: 3,
        type: 'attempt.started',
        invocationSequence: 1,
        attemptNumber: 1,
      },
    ]);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe(RuntimeErrorKind.IllegalStateTransition);
    }
  });

  test('rejects an automatic retry forbidden by recovery policy', () => {
    const artifact = compileOrThrow(
      workflowSource({
        nodes: [
          {
            id: 'command',
            type: 'command',
            command: 'deploy',
            recoveryPolicy: 'never_automatically_retry',
          },
          { id: 'complete', type: 'complete' },
        ],
      }),
    );
    const result = reduceRun(artifact, [
      {
        sequence: 1,
        type: 'run.created',
        workflowChecksum: artifact.checksum,
        startingCommit,
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
    ]);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe(RuntimeErrorKind.InvalidAttemptNumber);
    }
  });

  test('rejects events after a terminal run event', () => {
    const artifact = compileOrThrow(
      workflowSource({
        entryNodeId: 'complete',
        nodes: [{ id: 'complete', type: 'complete' }],
        transitions: [],
      }),
    );
    const result = reduceRun(artifact, [
      {
        sequence: 1,
        type: 'run.created',
        workflowChecksum: artifact.checksum,
        startingCommit,
        configuration: {},
      },
      {
        sequence: 2,
        type: 'invocation.activated',
        invocationSequence: 1,
        nodeId: 'complete',
      },
      {
        sequence: 3,
        type: 'run.completed',
        result: 'succeeded',
      },
      {
        sequence: 4,
        type: 'run.completed',
        result: 'succeeded',
      },
    ]);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe(RuntimeErrorKind.IllegalStateTransition);
    }
  });

  test('returns Result.Err for an unknown deserialized event', () => {
    const artifact = compileOrThrow();
    // Deliberately cross the static boundary to exercise malformed deserialized history.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const unknownEvent = {
      sequence: 2,
      type: 'future.event',
    } as unknown as RunEvent;
    const result = reduceRun(artifact, [
      {
        sequence: 1,
        type: 'run.created',
        workflowChecksum: artifact.checksum,
        startingCommit,
        configuration: {},
      },
      unknownEvent,
    ]);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toEqual({
        kind: RuntimeErrorKind.IllegalStateTransition,
        entity: 'run-event',
        from: 'running',
        event: 'unknown',
      });
    }
  });
});
