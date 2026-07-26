import { describe, expect, test } from 'bun:test';

import { compileWorkflow, CompilerErrorKind } from '@kairo/adw';
import { RuntimeErrorKind, simulate } from '@kairo/runtime';
import { compileOrThrow, workflowSource } from './fixtures.ts';

describe('ADR-0001: deterministic replay', () => {
  test('equivalent source ordering compiles byte-identically', () => {
    const first = compileOrThrow(
      workflowSource({
        permissions: ['terminal.execute', 'repository.read'],
        nodes: [
          { id: 'complete', type: 'complete' },
          {
            id: 'command',
            type: 'command',
            command: 'bun test',
            recoveryPolicy: 'replay_safe',
          },
        ],
      }),
    );
    const second = compileOrThrow(
      workflowSource({
        permissions: ['repository.read', 'terminal.execute'],
      }),
    );

    expect(first.canonical).toBe(second.canonical);
    expect(first.checksum).toBe(second.checksum);
  });

  test('the same history produces byte-identical state and intents', () => {
    const artifact = compileOrThrow();
    const events = [
      {
        sequence: 1,
        type: 'run.created' as const,
        workflowChecksum: artifact.checksum,
        startingCommit: '0123456789abcdef',
        configuration: {},
      },
    ];

    const first = simulate(artifact, events);
    const second = simulate(artifact, structuredClone(events));

    expect(first.isOk()).toBe(true);
    expect(second.isOk()).toBe(true);
    if (first.isOk() && second.isOk()) {
      expect(first.unwrap().canonical).toBe(second.unwrap().canonical);
      expect(first.unwrap().intents).toEqual([
        {
          type: 'invocation.activate',
          nodeId: 'command',
          invocationSequence: 1,
        },
      ]);
    }
  });

  test('non-contiguous history is a typed failure', () => {
    const artifact = compileOrThrow();
    const result = simulate(artifact, [
      {
        sequence: 2,
        type: 'run.created',
        workflowChecksum: artifact.checksum,
        startingCommit: '0123456789abcdef',
        configuration: {},
      },
    ]);

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.kind).toBe(RuntimeErrorKind.InvalidEventSequence);
    }
  });

  test('an unbounded cycle fails compilation', () => {
    const result = compileWorkflow(
      workflowSource({
        nodes: [
          {
            id: 'command',
            type: 'command',
            command: 'bun test',
            recoveryPolicy: 'replay_safe',
          },
        ],
        transitions: [
          {
            id: 'command.again',
            from: { nodeId: 'command', outcome: 'success' },
            toNodeId: 'command',
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
