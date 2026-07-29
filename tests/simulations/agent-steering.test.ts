import { describe, expect, test } from 'bun:test';

import { reduceRun } from '@kouro/runtime';
import { compileOrThrow, workflowSource } from './fixtures.ts';

describe('ADR-0028: durable agent steering', () => {
  test('records requested and applied steering without changing graph state', () => {
    const artifact = compileOrThrow(
      workflowSource({
        entryNodeId: 'agent',
        nodes: [
          {
            id: 'agent',
            type: 'agent',
            role: 'implementer',
            prompt: 'Implement.',
            capabilities: ['repository.read'],
            recoveryPolicy: 'resume_supported',
          },
        ],
        transitions: [],
        permissions: ['repository.read'],
      }),
    );
    const result = reduceRun(artifact, [
      {
        sequence: 1,
        type: 'run.created',
        workflowChecksum: artifact.checksum,
        startingCommit: '0123456789abcdef',
        configuration: { agentHarnesses: ['codex'] },
      },
      {
        sequence: 2,
        type: 'invocation.activated',
        invocationSequence: 1,
        nodeId: 'agent',
      },
      {
        sequence: 3,
        type: 'attempt.started',
        invocationSequence: 1,
        attemptNumber: 1,
        harnessId: 'codex',
      },
      {
        sequence: 4,
        type: 'agent.steering_requested',
        invocationSequence: 1,
        attemptNumber: 1,
        actor: 'operator',
        message: 'Preserve the public API.',
      },
      {
        sequence: 5,
        type: 'agent.steering_applied',
        invocationSequence: 1,
        attemptNumber: 1,
        requestSequence: 4,
      },
    ]);

    expect(result.isOk()).toBe(true);
    expect(result.unwrap().invocations[0]?.state).toBe('active');
    expect(result.unwrap().counters).toEqual({});
    expect(result.unwrap().invocations[0]?.attempts[0]?.steering).toEqual([
      {
        requestSequence: 4,
        actor: 'operator',
        message: 'Preserve the public API.',
        state: 'applied',
      },
    ]);
  });

  test('rejects steering for a non-active attempt', () => {
    const artifact = compileOrThrow(
      workflowSource({
        entryNodeId: 'agent',
        nodes: [
          {
            id: 'agent',
            type: 'agent',
            role: 'implementer',
            prompt: 'Implement.',
            recoveryPolicy: 'resume_supported',
          },
        ],
        transitions: [],
      }),
    );
    const result = reduceRun(artifact, [
      {
        sequence: 1,
        type: 'run.created',
        workflowChecksum: artifact.checksum,
        startingCommit: '0123456789abcdef',
        configuration: { agentHarnesses: ['codex'] },
      },
      {
        sequence: 2,
        type: 'invocation.activated',
        invocationSequence: 1,
        nodeId: 'agent',
      },
      {
        sequence: 3,
        type: 'agent.steering_requested',
        invocationSequence: 1,
        attemptNumber: 1,
        actor: 'operator',
        message: 'Too early.',
      },
    ]);

    expect(result.isErr()).toBe(true);
  });
});
