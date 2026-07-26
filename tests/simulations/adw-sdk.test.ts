import { describe, expect, test } from 'bun:test';

import {
  all,
  any,
  not,
  output,
  WorkflowAuthoringError,
  WorkflowAuthoringErrorKind,
  WorkflowBuilder,
} from '@kairo/adw';

function expectAuthoringError(operation: () => unknown, kind: WorkflowAuthoringErrorKind): void {
  try {
    operation();
    throw new Error('Expected authoring operation to fail');
  } catch (error) {
    expect(error).toBeInstanceOf(WorkflowAuthoringError);
    if (error instanceof WorkflowAuthoringError) {
      expect(error.kind).toBe(kind);
    }
  }
}

describe('class-based ADW authoring SDK', () => {
  test('emits the existing plain definition shape from fluent declarations', () => {
    const workflow = new WorkflowBuilder({ id: 'repair', version: '1.0.0' });
    workflow.permissions('repository.read', 'terminal.execute');
    workflow.defaults({ model: 'coding' });
    workflow.runLimits({ maxDurationMs: 10_000, maxNodeInvocations: 12 });
    workflow.subworkflow('shared', { package: '../shared', version: '2.0.0' });

    const repairs = workflow.counter('repairs', 2);
    const run = workflow.command('run', {
      command: 'bun test',
      capabilities: ['repository.read', 'terminal.execute'],
      recoveryPolicy: 'replay_safe',
    });
    const repair = workflow.agent('repair', {
      role: 'repairer',
      prompt: './repair.md',
      harness: 'pi',
      clearContext: true,
      recoveryPolicy: 'resume_supported',
    });
    const complete = workflow.complete('complete');
    const failed = workflow.complete('failed', { result: 'failed' });

    workflow.startAt(run);
    run.on('success').to(complete);
    run.on('failure').when(repairs.belowLimit()).increment(repairs).to(repair);
    run.on('failure').otherwise().to(failed);
    repair.on('success').to(run);

    expect(workflow.build()).toEqual({
      id: 'repair',
      version: '1.0.0',
      entry: 'run',
      nodes: {
        run: {
          type: 'command',
          command: 'bun test',
          capabilities: ['repository.read', 'terminal.execute'],
          recoveryPolicy: 'replay_safe',
        },
        repair: {
          type: 'agent',
          role: 'repairer',
          prompt: './repair.md',
          harness: 'pi',
          clearContext: true,
          recoveryPolicy: 'resume_supported',
        },
        complete: { type: 'complete' },
        failed: { type: 'complete', result: 'failed' },
      },
      transitions: [
        {
          id: 'run.success.complete',
          from: { nodeId: 'run', outcome: 'success' },
          toNodeId: 'complete',
        },
        {
          id: 'run.failure.repair',
          from: { nodeId: 'run', outcome: 'failure' },
          toNodeId: 'repair',
          condition: {
            op: 'lt',
            left: { scope: 'counter', name: 'repairs' },
            right: 2,
          },
          increment: 'repairs',
        },
        {
          id: 'run.failure.failed',
          from: { nodeId: 'run', outcome: 'failure' },
          toNodeId: 'failed',
          default: true,
        },
        {
          id: 'repair.success.run',
          from: { nodeId: 'repair', outcome: 'success' },
          toNodeId: 'run',
        },
      ],
      permissions: ['repository.read', 'terminal.execute'],
      defaults: { model: 'coding' },
      limits: {
        counters: { repairs: 2 },
        maxDurationMs: 10_000,
        maxNodeInvocations: 12,
      },
      subworkflows: {
        shared: { package: '../shared', version: '2.0.0' },
      },
    });
  });

  test('creates data-only expressions for outputs, counters, and boolean composition', () => {
    const workflow = new WorkflowBuilder({ id: 'expressions', version: '1.0.0' });
    const attempts = workflow.counter('attempts', 3);

    expect(output('result', 'approved').equals(true)).toEqual({
      op: 'eq',
      left: { scope: 'output', path: ['result', 'approved'] },
      right: true,
    });
    expect(attempts.lessThan(2)).toEqual({
      op: 'lt',
      left: { scope: 'counter', name: 'attempts' },
      right: 2,
    });
    expect(attempts.atLeast(2)).toEqual({
      op: 'gte',
      left: { scope: 'counter', name: 'attempts' },
      right: 2,
    });
    expect(
      all(output('approved').equals(false), any(attempts.belowLimit(), not(attempts.atLimit()))),
    ).toEqual({
      op: 'and',
      expressions: [
        {
          op: 'eq',
          left: { scope: 'output', path: ['approved'] },
          right: false,
        },
        {
          op: 'or',
          expressions: [
            {
              op: 'lt',
              left: { scope: 'counter', name: 'attempts' },
              right: 3,
            },
            {
              op: 'not',
              expression: {
                op: 'gte',
                left: { scope: 'counter', name: 'attempts' },
                right: 3,
              },
            },
          ],
        },
      ],
    });
  });

  test('fails fast for duplicate declarations and entry assignment', () => {
    const workflow = new WorkflowBuilder({ id: 'duplicates', version: '1.0.0' });
    const start = workflow.command('start', {
      command: 'true',
      recoveryPolicy: 'replay_safe',
    });
    workflow.counter('attempts', 2);
    workflow.startAt(start);

    expectAuthoringError(
      () => workflow.complete('start'),
      WorkflowAuthoringErrorKind.DuplicateNode,
    );
    expectAuthoringError(
      () => workflow.counter('attempts', 3),
      WorkflowAuthoringErrorKind.DuplicateCounter,
    );
    expectAuthoringError(() => workflow.startAt(start), WorkflowAuthoringErrorKind.DuplicateEntry);
  });

  test('rejects foreign node and counter handles', () => {
    const first = new WorkflowBuilder({ id: 'first', version: '1.0.0' });
    const second = new WorkflowBuilder({ id: 'second', version: '1.0.0' });
    const firstNode = first.command('first', {
      command: 'true',
      recoveryPolicy: 'replay_safe',
    });
    const secondNode = second.complete('second');
    const secondCounter = second.counter('attempts', 1);

    expectAuthoringError(
      () => first.startAt(secondNode),
      WorkflowAuthoringErrorKind.ForeignNodeHandle,
    );
    expectAuthoringError(
      () => firstNode.on('success').to(secondNode),
      WorkflowAuthoringErrorKind.ForeignNodeHandle,
    );
    expectAuthoringError(
      () => firstNode.on('failure').increment(secondCounter),
      WorkflowAuthoringErrorKind.ForeignCounterHandle,
    );
  });

  test('rejects missing entries and unfinished transition chains', () => {
    const missingEntry = new WorkflowBuilder({ id: 'missing', version: '1.0.0' });
    missingEntry.complete('complete');
    expectAuthoringError(() => missingEntry.build(), WorkflowAuthoringErrorKind.MissingEntry);

    const incomplete = new WorkflowBuilder({ id: 'incomplete', version: '1.0.0' });
    const start = incomplete.command('start', {
      command: 'true',
      recoveryPolicy: 'replay_safe',
    });
    incomplete.complete('complete');
    incomplete.startAt(start);
    start.on('success');
    expectAuthoringError(() => incomplete.build(), WorkflowAuthoringErrorKind.IncompleteTransition);
  });
});

function compileTimeHandleContracts(): void {
  const workflow = new WorkflowBuilder({ id: 'types', version: '1.0.0' });
  const counter = workflow.counter('attempts', 1);
  const command = workflow.command('command', {
    command: 'true',
    recoveryPolicy: 'replay_safe',
  });
  const complete = workflow.complete('complete');

  command.on('success').increment(counter).to(complete);

  // @ts-expect-error Complete nodes are terminal and do not expose transitions.
  complete.on('success');
  // @ts-expect-error Counter handles cannot be transition targets.
  command.on('failure').to(counter);
  // @ts-expect-error Node handles cannot be used as counters.
  command.on('failure').increment(complete);
}

void compileTimeHandleContracts;
