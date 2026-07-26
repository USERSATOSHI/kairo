const workflow = {
  id: '{{id}}',
  version: '1.0.0',
  entry: 'implement',
  permissions: ['repository.read', 'repository.write', 'terminal.execute'],
  limits: {
    maxDurationMs: 4 * 60 * 60 * 1000,
    maxNodeInvocations: 8,
  },
  nodes: {
    implement: {
      type: 'agent',
      role: 'maintainer',
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
