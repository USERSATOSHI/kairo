const workflow = {
  id: '{{id}}',
  version: '1.0.0',
  entry: 'assess',
  permissions: ['repository.read', 'repository.write', 'terminal.execute'],
  limits: {
    maxDurationMs: 2 * 60 * 60 * 1000,
    maxNodeInvocations: 10,
  },
  nodes: {
    assess: {
      type: 'agent',
      role: 'hotfix-assessor',
      prompt: './prompts/assess.md',
      capabilities: ['repository.read'],
      recoveryPolicy: 'resume_supported',
    },
    implement: {
      type: 'agent',
      role: 'hotfix-implementer',
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
      id: 'assess.success.implement',
      from: { nodeId: 'assess', outcome: 'success' },
      toNodeId: 'implement',
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
