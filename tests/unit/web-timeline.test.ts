import { describe, expect, test } from 'bun:test';

import type { RunDetails } from '@kouro/api-contracts';

import { isTerminalRun, timelineModel } from '../../packages/web/src/timeline.ts';

function runDetails(status: RunDetails['status'] = 'running'): RunDetails {
  return {
    id: 'run-1',
    repositoryId: 'kouro',
    repositoryPath: '/repositories/kouro',
    workflowId: 'chore',
    workflowVersion: '1.0.0',
    workflowChecksum: 'sha256:workflow',
    status,
    startingCommit: 'abc123',
    eventCount: 7,
    invocationCount: 3,
    pendingApprovalCount: 0,
    entryNodeId: 'implement',
    repositoryHead: 'abc123',
    state: {
      workflowChecksum: 'sha256:workflow',
      startingCommit: 'abc123',
      repositoryHead: 'abc123',
      configuration: {},
      status,
      nextInvocationSequence: 5,
      counters: {},
      invocations: [
        {
          sequence: 1,
          nodeId: 'implement',
          state: 'succeeded',
          outcome: 'success',
          attempts: [{ number: 1, state: 'succeeded', model: 'gpt-4o' }],
        },
        {
          sequence: 2,
          nodeId: 'implement',
          state: 'failed',
          outcome: 'failure',
          attempts: [
            { number: 1, state: 'failed', model: 'gpt-4o' },
            { number: 2, state: 'failed', model: 'gpt-4o-mini' },
          ],
        },
        {
          sequence: 3,
          nodeId: 'validate',
          state: 'pending',
          attempts: [],
        },
      ],
    },
    nodes: [
      {
        id: 'implement',
        type: 'agent',
        title: 'Implement',
        ordinal: 0,
        invocations: [1, 2],
        recoveryPolicy: 'replay_safe',
        skipOutcome: 'skip',
        latestState: 'failed',
      },
      {
        id: 'validate',
        type: 'command',
        title: 'Validate',
        ordinal: 1,
        invocations: [3],
        latestState: 'pending',
      },
    ],
    edges: [],
  };
}

describe('web timeline model', () => {
  test('lanes follow workflow ordinal order and carry their blocks', () => {
    const model = timelineModel(runDetails());
    expect(model.lanes.map((lane) => lane.nodeId)).toEqual(['implement', 'validate']);
    expect(model.lanes[0]?.blocks.map((block) => block.invocationSequence)).toEqual([1, 2]);
    expect(model.lanes[1]?.blocks.map((block) => block.invocationSequence)).toEqual([3]);
    expect(model.tickCount).toBe(3);
  });

  test('blocks are ordered by invocation sequence regardless of node grouping', () => {
    const model = timelineModel(runDetails());
    const flattened = model.lanes.flatMap((lane) => lane.blocks);
    expect(flattened.map((block) => block.invocationSequence)).toEqual([1, 2, 3]);
  });

  test('a pending invocation is a queued block without attempts', () => {
    const model = timelineModel(runDetails());
    const queued = model.lanes[1]?.blocks[0];
    expect(queued).toMatchObject({ queued: true, attemptCount: 0, state: 'pending' });
  });

  test('activated invocations carry attempts, harness, and last attempt model', () => {
    const model = timelineModel(runDetails());
    const second = model.lanes[0]?.blocks[1];
    expect(second).toMatchObject({
      queued: false,
      attemptCount: 2,
      state: 'failed',
      model: 'gpt-4o-mini',
    });
  });

  test('a failed invocation is displayed as failed even while its node retries', () => {
    const model = timelineModel(runDetails());
    expect(model.lanes[0]?.blocks[1]?.state).toBe('failed');
  });

  test('blocks carry reported token usage and estimated cost for the latest attempt', () => {
    const run = runDetails();
    const model = timelineModel({
      ...run,
      state: {
        ...run.state,
        invocations: run.state.invocations.map((invocation, index) =>
          index === 0
            ? {
                ...invocation,
                attempts: [
                  {
                    number: 1,
                    state: 'succeeded' as const,
                    model: 'gpt-4o',
                    usage: { inputTokens: 1_000_000, outputTokens: 200_000 },
                  },
                ],
              }
            : invocation,
        ),
      },
    });
    const block = model.lanes[0]?.blocks[0];
    expect(block?.usage).toEqual({ inputTokens: 1_000_000, outputTokens: 200_000 });
    expect(block?.costUsd).toBeCloseTo(4.5, 5);
  });

  test('blocks without usage or an unpriced model carry no cost estimate', () => {
    const run = runDetails();
    const model = timelineModel({
      ...run,
      state: {
        ...run.state,
        invocations: run.state.invocations.map((invocation, index) =>
          index === 0
            ? {
                ...invocation,
                attempts: [{ number: 1, state: 'succeeded' as const, model: 'my-private-model' }],
              }
            : invocation,
        ),
      },
    });
    expect(model.lanes[0]?.blocks[0]?.usage).toBeUndefined();
    expect(model.lanes[0]?.blocks[0]?.costUsd).toBeUndefined();
  });

  test('a terminal run resolves a pending complete node to the run status', () => {
    const model = timelineModel({
      ...runDetails('succeeded'),
      state: {
        ...runDetails('succeeded').state,
        invocations: [
          ...runDetails('succeeded').state.invocations,
          { sequence: 4, nodeId: 'deliver', state: 'pending', attempts: [] },
        ],
      },
      nodes: [
        ...runDetails('succeeded').nodes,
        {
          id: 'deliver',
          type: 'complete',
          title: 'Deliver',
          ordinal: 2,
          invocations: [4],
          latestState: 'pending',
        },
      ],
    });
    const deliver = model.lanes.find((lane) => lane.nodeId === 'deliver');
    expect(deliver?.blocks[0]).toMatchObject({ state: 'succeeded', queued: true });
  });

  test('an empty run produces lanes with no blocks and zero ticks', () => {
    const model = timelineModel({
      ...runDetails(),
      state: { ...runDetails().state, invocations: [] },
    });
    expect(model.tickCount).toBe(0);
    expect(model.lanes.every((lane) => lane.blocks.length === 0)).toBe(true);
  });

  test('terminal run detection covers the three durable terminal statuses', () => {
    expect(isTerminalRun('succeeded')).toBe(true);
    expect(isTerminalRun('failed')).toBe(true);
    expect(isTerminalRun('cancelled')).toBe(true);
    expect(isTerminalRun('running')).toBe(false);
    expect(isTerminalRun('paused')).toBe(false);
    expect(isTerminalRun('waiting_for_approval')).toBe(false);
  });
});
