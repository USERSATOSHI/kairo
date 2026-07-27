import type { CompiledWorkflowArtifact, RunEvent, WorkflowSourceBundle } from '@kouro/domain';
import { compileWorkflow } from '@kouro/adw';

export function workflowSource(
  overrides: Partial<WorkflowSourceBundle> = {},
): WorkflowSourceBundle {
  return {
    manifest: {
      id: 'simulation',
      version: '1.0.0',
    },
    semanticVersions: {
      compiler: '0.1.0',
      ir: '1',
      expressions: '1',
    },
    entryNodeId: 'command',
    nodes: [
      {
        id: 'command',
        type: 'command',
        command: 'bun test',
        recoveryPolicy: 'replay_safe',
      },
      { id: 'complete', type: 'complete' },
    ],
    transitions: [
      {
        id: 'command.success.complete',
        from: { nodeId: 'command', outcome: 'success' },
        toNodeId: 'complete',
      },
    ],
    counterLimits: {},
    ...overrides,
  };
}

export function compileOrThrow(
  source: WorkflowSourceBundle = workflowSource(),
): CompiledWorkflowArtifact {
  const compiled = compileWorkflow(source);
  if (compiled.isErr()) {
    throw new Error(`Compilation failed: ${JSON.stringify(compiled.error)}`);
  }
  return compiled.unwrap();
}

export function interruptedEvents(
  artifact: CompiledWorkflowArtifact,
  resumeToken?: string,
): readonly RunEvent[] {
  return [
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
      nodeId: artifact.bundle.entryNodeId,
    },
    {
      sequence: 3,
      type: 'attempt.started',
      invocationSequence: 1,
      attemptNumber: 1,
      ...(resumeToken ? { resumeToken } : {}),
    },
    {
      sequence: 4,
      type: 'attempt.interrupted',
      invocationSequence: 1,
      attemptNumber: 1,
    },
  ];
}
