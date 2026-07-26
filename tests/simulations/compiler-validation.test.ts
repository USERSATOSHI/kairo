import { describe, expect, test } from 'bun:test';

import { compileWorkflow, CompilerErrorKind } from '@kairo/adw';
import type { RecoveryPolicy } from '@kairo/domain';
import { workflowSource } from './fixtures.ts';

describe('M1 compiler validation', () => {
  test('rejects unreachable nodes', () => {
    const result = compileWorkflow(
      workflowSource({
        nodes: [
          {
            id: 'command',
            type: 'command',
            command: 'bun test',
            recoveryPolicy: 'replay_safe',
          },
          { id: 'complete', type: 'complete' },
          { id: 'orphan', type: 'complete' },
        ],
      }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toEqual({
        kind: CompilerErrorKind.UnreachableNode,
        nodeIds: ['orphan'],
      });
    }
  });

  test('rejects capabilities absent from workflow permissions', () => {
    const result = compileWorkflow(
      workflowSource({
        nodes: [
          {
            id: 'command',
            type: 'command',
            command: 'bun test',
            recoveryPolicy: 'replay_safe',
            capabilities: ['terminal.execute'],
          },
          { id: 'complete', type: 'complete' },
        ],
        permissions: [],
      }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe(CompilerErrorKind.PermissionNotDeclared);
    }
  });

  test('rejects invalid expression references', () => {
    const result = compileWorkflow(
      workflowSource({
        transitions: [
          {
            id: 'command.success.complete',
            from: { nodeId: 'command', outcome: 'success' },
            toNodeId: 'complete',
            condition: {
              op: 'lt',
              left: {
                scope: 'counter',
                name: 'missing',
              },
              right: 1,
            },
          },
        ],
      }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe(CompilerErrorKind.InvalidExpression);
    }
  });

  test('rejects malformed transition outcomes with a typed error', () => {
    const result = compileWorkflow(
      workflowSource({
        transitions: [
          {
            id: 'invalid',
            from: { nodeId: 'command', outcome: '' },
            toNodeId: 'complete',
          },
        ],
      }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe(CompilerErrorKind.InvalidTransition);
    }
  });

  test('rejects nondeterministic numeric priorities', () => {
    const result = compileWorkflow(
      workflowSource({
        nodes: [
          {
            id: 'command',
            type: 'command',
            command: 'bun test',
            recoveryPolicy: 'replay_safe',
            priority: Number.NaN,
          },
          { id: 'complete', type: 'complete' },
        ],
      }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe(CompilerErrorKind.InvalidNodeConfiguration);
    }
  });

  test('rejects invalid workflow harness pins', () => {
    for (const nodes of [
      [
        {
          id: 'command',
          type: 'command' as const,
          command: 'bun test',
          harness: 'codex',
          recoveryPolicy: 'replay_safe' as const,
        },
        { id: 'complete', type: 'complete' as const },
      ],
      [
        {
          id: 'agent',
          type: 'agent' as const,
          role: 'reviewer',
          prompt: 'Review.',
          harness: ' ',
          recoveryPolicy: 'resume_supported' as const,
        },
        { id: 'complete', type: 'complete' as const },
      ],
    ]) {
      const result = compileWorkflow(
        workflowSource({
          entryNodeId: nodes[0]?.id ?? '',
          nodes,
          transitions: [
            {
              id: 'entry.success.complete',
              from: { nodeId: nodes[0]?.id ?? '', outcome: 'success' },
              toNodeId: 'complete',
            },
          ],
        }),
      );
      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.kind).toBe(CompilerErrorKind.InvalidNodeConfiguration);
      }
    }
  });

  test('rejects an unsupported recovery policy', () => {
    const result = compileWorkflow(
      workflowSource({
        nodes: [
          {
            id: 'command',
            type: 'command',
            command: 'bun test',
            // Deliberately cross the static boundary to test runtime validation.
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            recoveryPolicy: 'automatic' as RecoveryPolicy,
          },
          { id: 'complete', type: 'complete' },
        ],
      }),
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toEqual({
        kind: CompilerErrorKind.InvalidNodeConfiguration,
        nodeId: 'command',
        reason: 'command recoveryPolicy is unsupported',
      });
    }
  });

  test('rejects non-positive global run limits', () => {
    const result = compileWorkflow(
      workflowSource({
        runLimits: { maxNodeInvocations: 0 },
      }),
    );

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error).toEqual({
        kind: CompilerErrorKind.InvalidRunLimit,
        limit: 'maxNodeInvocations',
        value: 0,
      });
    }
  });

  test('rejects a cycle that can bypass its bounded edge', () => {
    const result = compileWorkflow(
      workflowSource({
        entryNodeId: 'a',
        nodes: [
          {
            id: 'a',
            type: 'command',
            command: 'a',
            recoveryPolicy: 'replay_safe',
          },
          {
            id: 'b',
            type: 'command',
            command: 'b',
            recoveryPolicy: 'replay_safe',
          },
          {
            id: 'c',
            type: 'command',
            command: 'c',
            recoveryPolicy: 'replay_safe',
          },
        ],
        counterLimits: { bounded: 1 },
        transitions: [
          {
            id: 'a.b',
            from: { nodeId: 'a', outcome: 'b' },
            toNodeId: 'b',
            increment: 'bounded',
            condition: {
              op: 'lt',
              left: {
                scope: 'counter',
                name: 'bounded',
              },
              right: 1,
            },
          },
          {
            id: 'b.a',
            from: { nodeId: 'b', outcome: 'a' },
            toNodeId: 'a',
          },
          {
            id: 'a.c',
            from: { nodeId: 'a', outcome: 'c' },
            toNodeId: 'c',
          },
          {
            id: 'c.a',
            from: { nodeId: 'c', outcome: 'a' },
            toNodeId: 'a',
          },
        ],
      }),
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe(CompilerErrorKind.UnboundedCycle);
    }
  });
});
