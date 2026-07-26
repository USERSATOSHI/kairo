import { describe, expect, test } from 'bun:test';

import type { OrchestrationIntent, RecoveryPolicy } from '@kairo/domain';
import { reduceRun, scheduleRun } from '@kairo/runtime';
import { compileOrThrow, interruptedEvents, workflowSource } from './fixtures.ts';

function recoveryDecision(policy: RecoveryPolicy, resumeToken?: string): OrchestrationIntent {
  const artifact = compileOrThrow(
    workflowSource({
      nodes: [
        {
          id: 'command',
          type: 'command',
          command: 'bun test',
          recoveryPolicy: policy,
        },
        { id: 'complete', type: 'complete' },
      ],
    }),
  );
  const reduced = reduceRun(artifact, interruptedEvents(artifact, resumeToken));
  if (reduced.isErr()) {
    throw new Error(JSON.stringify(reduced.error));
  }
  const scheduled = scheduleRun(artifact, reduced.unwrap());
  if (scheduled.isErr()) {
    throw new Error(JSON.stringify(scheduled.error));
  }
  const intent = scheduled.unwrap()[0];
  if (!intent) {
    throw new Error('Expected one recovery intent');
  }
  return intent;
}

describe('ADR-0005: deterministic recovery classifications', () => {
  test.each([
    [
      'replay_safe',
      {
        type: 'attempt.schedule',
        invocationSequence: 1,
        attemptNumber: 2,
      },
    ],
    [
      'verify_then_replay',
      {
        type: 'effect.verify',
        invocationSequence: 1,
        attemptNumber: 1,
      },
    ],
    [
      'manual_reconciliation',
      {
        type: 'reconciliation.request',
        invocationSequence: 1,
      },
    ],
    [
      'never_automatically_retry',
      {
        type: 'recovery.halt',
        invocationSequence: 1,
      },
    ],
  ] as const)('%s maps to its declared intent', (policy, expected) => {
    expect(recoveryDecision(policy)).toEqual(expected);
    expect(recoveryDecision(policy)).toEqual(expected);
  });

  test('resume_supported resumes only with a durable token', () => {
    expect(recoveryDecision('resume_supported', 'session-1')).toEqual({
      type: 'session.resume',
      invocationSequence: 1,
      token: 'session-1',
    });
    expect(recoveryDecision('resume_supported')).toEqual({
      type: 'reconciliation.request',
      invocationSequence: 1,
    });
  });
});
