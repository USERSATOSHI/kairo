const workflow = {
  id: '{{id}}',
  version: '1.0.0',
  entry: 'reproduce',
  permissions: ['repository.read', 'repository.write', 'terminal.execute'],
  limits: {
    maxDurationMs: 4 * 60 * 60 * 1000,
    maxNodeInvocations: 12,
  },
  nodes: {
    reproduce: {
      type: 'agent',
      role: 'bug-investigator',
      prompt: './prompts/reproduce.md',
      capabilities: ['repository.read', 'terminal.execute'],
      recoveryPolicy: 'resume_supported',
    },
    fix: {
      type: 'agent',
      role: 'bug-fixer',
      prompt: './prompts/fix.md',
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
      id: 'reproduce.success.fix',
      from: { nodeId: 'reproduce', outcome: 'success' },
      toNodeId: 'fix',
    },
    {
      id: 'fix.success.validate',
      from: { nodeId: 'fix', outcome: 'success' },
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
