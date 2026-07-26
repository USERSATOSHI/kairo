const workflow = {
  id: '{{id}}',
  version: '1.0.0',
  entry: 'plan',
  permissions: ['repository.read', 'repository.write', 'terminal.execute'],
  limits: {
    maxDurationMs: 8 * 60 * 60 * 1000,
    maxNodeInvocations: 20,
  },
  nodes: {
    plan: {
      type: 'agent',
      role: 'planner',
      prompt: './prompts/plan.md',
      capabilities: ['repository.read'],
      recoveryPolicy: 'resume_supported',
    },
    approval: {
      type: 'approval',
      title: 'Approve feature implementation plan',
    },
    implement: {
      type: 'agent',
      role: 'implementer',
      prompt: './prompts/implement.md',
      capabilities: ['repository.read', 'repository.write', 'terminal.execute'],
      recoveryPolicy: 'resume_supported',
    },
    validate: {
      type: 'command',
      command: 'bun run format && bun run lint && bun run typecheck && bun test',
      capabilities: ['repository.read', 'terminal.execute'],
      recoveryPolicy: 'replay_safe',
    },
    complete: { type: 'complete' },
    failed: { type: 'complete', result: 'failed' },
  },
  transitions: [
    {
      id: 'plan.success.approval',
      from: { nodeId: 'plan', outcome: 'success' },
      toNodeId: 'approval',
    },
    {
      id: 'approval.approved.implement',
      from: { nodeId: 'approval', outcome: 'approved' },
      toNodeId: 'implement',
    },
    {
      id: 'approval.rejected.failed',
      from: { nodeId: 'approval', outcome: 'rejected' },
      toNodeId: 'failed',
    },
    {
      id: 'implement.success.validate',
      from: { nodeId: 'implement', outcome: 'success' },
      toNodeId: 'validate',
    },
    {
      id: 'validate.success.complete',
      from: { nodeId: 'validate', outcome: 'success' },
      toNodeId: 'complete',
    },
    {
      id: 'validate.failure.failed',
      from: { nodeId: 'validate', outcome: 'failure' },
      toNodeId: 'failed',
    },
  ],
};

export default workflow;
