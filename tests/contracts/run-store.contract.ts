import { describe, expect, test } from 'bun:test';

import type { RunStore } from '@kouro/executors';
import { RunStoreErrorKind } from '@kouro/executors';
import { compileOrThrow } from '../simulations/fixtures.ts';

export interface RunStoreHarness {
  readonly store: RunStore;
  dispose(): void;
}

export type RunStoreHarnessFactory = () => RunStoreHarness;

export function runStoreContract(name: string, createHarness: RunStoreHarnessFactory): void {
  describe(`${name} RunStore contract`, () => {
    test('commits an event once for one idempotency key', () => {
      const harness = createHarness();
      try {
        const artifact = compileOrThrow();
        const created = harness.store.createRun({
          runId: 'idempotent-run',
          artifact,
          startingCommit: 'abc123',
          configuration: {},
          idempotencyKey: 'create',
        });
        expect(created.isOk()).toBe(true);

        const request = {
          runId: 'idempotent-run',
          expectedSequence: 2,
          idempotencyKey: 'activate:1',
          event: {
            type: 'invocation.activated' as const,
            invocationSequence: 1,
            nodeId: 'command',
          },
        };
        const first = harness.store.appendEvent(request);
        const duplicate = harness.store.appendEvent(request);
        expect(first.unwrap().events).toHaveLength(2);
        expect(duplicate.unwrap().events).toHaveLength(2);
        expect(duplicate.unwrap().nextEventSequence).toBe(3);
      } finally {
        harness.dispose();
      }
    });

    test('rejects key reuse with a different request and a duplicate sequence', () => {
      const harness = createHarness();
      try {
        const artifact = compileOrThrow();
        harness.store
          .createRun({
            runId: 'conflict-run',
            artifact,
            startingCommit: 'abc123',
            configuration: {},
            idempotencyKey: 'create',
          })
          .unwrap();
        harness.store
          .appendEvent({
            runId: 'conflict-run',
            expectedSequence: 2,
            idempotencyKey: 'event-key',
            event: {
              type: 'invocation.activated',
              invocationSequence: 1,
              nodeId: 'command',
            },
          })
          .unwrap();

        const keyConflict = harness.store.appendEvent({
          runId: 'conflict-run',
          expectedSequence: 3,
          idempotencyKey: 'event-key',
          event: {
            type: 'run.completed',
            result: 'succeeded',
          },
        });
        expect(keyConflict.isErr()).toBe(true);
        if (keyConflict.isErr()) {
          expect(keyConflict.error.kind).toBe(RunStoreErrorKind.IdempotencyConflict);
        }

        const sequenceConflict = harness.store.appendEvent({
          runId: 'conflict-run',
          expectedSequence: 2,
          idempotencyKey: 'different-key',
          event: {
            type: 'attempt.started',
            invocationSequence: 1,
            attemptNumber: 1,
          },
        });
        expect(sequenceConflict.isErr()).toBe(true);
        if (sequenceConflict.isErr()) {
          expect(sequenceConflict.error.kind).toBe(RunStoreErrorKind.EventSequenceConflict);
        }
      } finally {
        harness.dispose();
      }
    });
  });
}
