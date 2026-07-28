const workflow = {
  id: 'feature-development',
  version: '1.0.0',
  entry: 'worktree',
  permissions: ['repository.read', 'repository.write', 'terminal.execute'],
  limits: {
    counters: {
      testRepair: 3,
      reviewRepair: 2,
      deliveryRepair: 2,
    },
    maxDurationMs: 8 * 60 * 60 * 1000,
    maxNodeInvocations: 30,
  },
  nodes: {
    worktree: {
      type: 'command',
      command: 'git rev-parse --is-inside-work-tree',
      capabilities: ['repository.read', 'terminal.execute'],
      recoveryPolicy: 'replay_safe',
    },
    plan: {
      type: 'agent',
      role: 'planner',
      prompt: './prompts/plan.md',
      outputSchema: './schemas/plan.schema.ts',
      capabilities: ['repository.read'],
      recoveryPolicy: 'resume_supported',
    },
    planApproval: {
      type: 'approval',
      title: 'Approve implementation plan',
    },
    implement: {
      type: 'agent',
      role: 'implementer',
      prompt: './prompts/implement.md',
      outputSchema: './schemas/change.schema.ts',
      capabilities: ['repository.read', 'repository.write', 'terminal.execute'],
      recoveryPolicy: 'resume_supported',
    },
    validate: {
      type: 'command',
      command: 'bun run lint && bun run format && bun test',
      capabilities: ['repository.read', 'terminal.execute'],
      recoveryPolicy: 'replay_safe',
    },
    review: {
      type: 'agent',
      role: 'reviewer',
      prompt: './prompts/review.md',
      outputSchema: './schemas/review.schema.ts',
      capabilities: ['repository.read'],
      recoveryPolicy: 'resume_supported',
    },
    deliveryApproval: {
      type: 'delivery_review',
      title: 'Approve merge-ready delivery',
      proposalFrom: 'review',
    },
    complete: { type: 'complete' },
    failed: { type: 'complete', result: 'failed' },
  },
  transitions: [
    {
      id: 'worktree.success.plan',
      from: { nodeId: 'worktree', outcome: 'success' },
      toNodeId: 'plan',
    },
    {
      id: 'worktree.failure.failed',
      from: { nodeId: 'worktree', outcome: 'failure' },
      toNodeId: 'failed',
    },
    {
      id: 'plan.success.planApproval',
      from: { nodeId: 'plan', outcome: 'success' },
      toNodeId: 'planApproval',
    },
    {
      id: 'planApproval.approved.implement',
      from: { nodeId: 'planApproval', outcome: 'approved' },
      toNodeId: 'implement',
    },
    {
      id: 'planApproval.rejected.failed',
      from: { nodeId: 'planApproval', outcome: 'rejected' },
      toNodeId: 'failed',
    },
    {
      id: 'implement.success.validate',
      from: { nodeId: 'implement', outcome: 'success' },
      toNodeId: 'validate',
    },
    {
      id: 'validate.success.review',
      from: { nodeId: 'validate', outcome: 'success' },
      toNodeId: 'review',
    },
    {
      id: 'validate.failure.implement',
      from: { nodeId: 'validate', outcome: 'failure' },
      toNodeId: 'implement',
      condition: {
        op: 'lt',
        left: { scope: 'counter', name: 'testRepair' },
        right: 3,
      },
      increment: 'testRepair',
    },
    {
      id: 'validate.failure.failed',
      from: { nodeId: 'validate', outcome: 'failure' },
      toNodeId: 'failed',
      condition: {
        op: 'gte',
        left: { scope: 'counter', name: 'testRepair' },
        right: 3,
      },
    },
    {
      id: 'review.success.deliveryApproval',
      from: { nodeId: 'review', outcome: 'success' },
      toNodeId: 'deliveryApproval',
      condition: {
        op: 'eq',
        left: { scope: 'output', path: ['approved'] },
        right: true,
      },
    },
    {
      id: 'review.success.implement',
      from: { nodeId: 'review', outcome: 'success' },
      toNodeId: 'implement',
      condition: {
        op: 'and',
        expressions: [
          {
            op: 'eq',
            left: { scope: 'output', path: ['approved'] },
            right: false,
          },
          {
            op: 'lt',
            left: { scope: 'counter', name: 'reviewRepair' },
            right: 2,
          },
        ],
      },
      increment: 'reviewRepair',
    },
    {
      id: 'review.success.failed',
      from: { nodeId: 'review', outcome: 'success' },
      toNodeId: 'failed',
      condition: {
        op: 'and',
        expressions: [
          {
            op: 'eq',
            left: { scope: 'output', path: ['approved'] },
            right: false,
          },
          {
            op: 'gte',
            left: { scope: 'counter', name: 'reviewRepair' },
            right: 2,
          },
        ],
      },
    },
    {
      id: 'deliveryApproval.approved.complete',
      from: { nodeId: 'deliveryApproval', outcome: 'approved' },
      toNodeId: 'complete',
    },
    {
      id: 'deliveryApproval.changes_requested.implement',
      from: { nodeId: 'deliveryApproval', outcome: 'changes_requested' },
      toNodeId: 'implement',
      condition: {
        op: 'lt',
        left: { scope: 'counter', name: 'deliveryRepair' },
        right: 2,
      },
      increment: 'deliveryRepair',
    },
    {
      id: 'deliveryApproval.rejected.failed',
      from: { nodeId: 'deliveryApproval', outcome: 'rejected' },
      toNodeId: 'failed',
    },
  ],
};

export default workflow;
