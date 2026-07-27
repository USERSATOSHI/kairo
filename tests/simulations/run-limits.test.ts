import { describe, expect, test } from 'bun:test';

import type { RunEvent } from '@kouro/domain';
import { reduceRun, scheduleRun } from '@kouro/runtime';
import { compileOrThrow, workflowSource } from './fixtures.ts';

describe('ADR-0009: deterministic run limits and terminal results', () => {
  test('the duration limit is decided from recorded time', () => {
    const artifact = compileOrThrow(
      workflowSource({
        entryNodeId: 'complete',
        nodes: [{ id: 'complete', type: 'complete' }],
        transitions: [],
        runLimits: { maxDurationMs: 8 * 60 * 60 * 1000 },
      }),
    );
    const events: RunEvent[] = [
      {
        sequence: 1,
        type: 'run.created',
        workflowChecksum: artifact.checksum,
        startingCommit: '0123456789abcdef',
        configuration: {},
        startedAt: '2026-07-26T00:00:00.000Z',
      },
      {
        sequence: 2,
        type: 'run.time_observed',
        observedAt: '2026-07-26T08:00:00.000Z',
      },
    ];

    const state = reduceRun(artifact, events).unwrap();
    expect(scheduleRun(artifact, state).unwrap()).toEqual([
      { type: 'run.complete', result: 'failed' },
    ]);
    expect(
      reduceRun(artifact, [
        ...events,
        { sequence: 3, type: 'run.completed', result: 'failed' },
      ]).unwrap().status,
    ).toBe('failed');
  });

  test('the invocation limit blocks only the next graph activation', () => {
    const artifact = compileOrThrow(
      workflowSource({
        runLimits: { maxNodeInvocations: 1 },
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
      },
    ];

    const state = reduceRun(artifact, events).unwrap();
    expect(scheduleRun(artifact, state).unwrap()).toEqual([
      { type: 'run.complete', result: 'failed' },
    ]);
  });

  test('a failed completion node produces a failed run', () => {
    const artifact = compileOrThrow(
      workflowSource({
        entryNodeId: 'failed',
        nodes: [{ id: 'failed', type: 'complete', result: 'failed' }],
        transitions: [],
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
        nodeId: 'failed',
      },
    ];
    const state = reduceRun(artifact, events).unwrap();
    expect(scheduleRun(artifact, state).unwrap()).toEqual([
      { type: 'run.complete', result: 'failed' },
    ]);
  });

  test('observed time cannot move backwards', () => {
    const artifact = compileOrThrow(
      workflowSource({
        runLimits: { maxDurationMs: 1_000 },
      }),
    );
    const reduced = reduceRun(artifact, [
      {
        sequence: 1,
        type: 'run.created',
        workflowChecksum: artifact.checksum,
        startingCommit: '0123456789abcdef',
        configuration: {},
        startedAt: '2026-07-26T00:00:01.000Z',
      },
      {
        sequence: 2,
        type: 'run.time_observed',
        observedAt: '2026-07-26T00:00:00.000Z',
      },
    ]);

    expect(reduced.isErr()).toBe(true);
  });
});
