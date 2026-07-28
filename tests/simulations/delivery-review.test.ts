import { describe, expect, test } from 'bun:test';

import { compileWorkflow } from '@kouro/adw';
import type { DeliveryProposal, RunEvent, WorkflowSourceBundle } from '@kouro/domain';
import { reduceRun, scheduleRun } from '@kouro/runtime';

const source: WorkflowSourceBundle = {
  manifest: { id: 'delivery-review', version: '1.0.0' },
  semanticVersions: { compiler: 'test', ir: '1', expressions: '1' },
  entryNodeId: 'implement',
  nodes: [
    {
      id: 'implement',
      type: 'agent',
      role: 'implementer',
      prompt: 'Implement',
      recoveryPolicy: 'resume_supported',
    },
    {
      id: 'delivery',
      type: 'delivery_review',
      title: 'Review delivery',
      proposalFrom: 'implement',
    },
    { id: 'complete', type: 'complete' },
  ],
  transitions: [
    {
      id: 'implement.success.delivery',
      from: { nodeId: 'implement', outcome: 'success' },
      toNodeId: 'delivery',
    },
    {
      id: 'delivery.approved.complete',
      from: { nodeId: 'delivery', outcome: 'approved' },
      toNodeId: 'complete',
    },
    {
      id: 'delivery.changes_requested.complete',
      from: { nodeId: 'delivery', outcome: 'changes_requested' },
      toNodeId: 'complete',
    },
    {
      id: 'delivery.rejected.complete',
      from: { nodeId: 'delivery', outcome: 'rejected' },
      toNodeId: 'complete',
    },
  ],
  counterLimits: {},
};

describe('delivery review runtime', () => {
  test('waits for a durable proposal and binds approval to its exact tree', () => {
    const artifact = compileWorkflow(source).unwrap();
    const events: RunEvent[] = [
      {
        sequence: 1,
        type: 'run.created',
        workflowChecksum: artifact.checksum,
        startingCommit: 'head',
        configuration: { agentHarnesses: ['fake'] },
      },
      {
        sequence: 2,
        type: 'invocation.activated',
        invocationSequence: 1,
        nodeId: 'implement',
      },
      {
        sequence: 3,
        type: 'attempt.started',
        invocationSequence: 1,
        attemptNumber: 1,
        harnessId: 'fake',
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
        nodeId: 'delivery',
        sourceInvocationSequence: 1,
        transitionId: 'implement.success.delivery',
      },
    ];
    const before = reduceRun(artifact, events).unwrap();
    expect(scheduleRun(artifact, before).unwrap()).toEqual([]);

    const proposal: DeliveryProposal = {
      invocationSequence: 2,
      preparedHead: 'head',
      preparedTree: 'tree',
      metadata: {
        commitTitle: 'Delivery',
        pullRequestTitle: 'Delivery',
        draft: false,
      },
      artifactChecksums: [],
      checksum: `sha256:${'a'.repeat(64)}`,
    };
    const proposed = reduceRun(artifact, [
      ...events,
      { sequence: 6, type: 'delivery.proposed', proposal },
    ]).unwrap();
    const intent = scheduleRun(artifact, proposed).unwrap()[0];
    expect(intent?.type).toBe('approval.request');
    if (intent?.type !== 'approval.request') throw new Error('approval intent missing');
    expect(intent.binding.preparedTree).toBe('tree');
    expect(intent.binding.proposalChecksum).toBe(proposal.checksum);
  });
});
