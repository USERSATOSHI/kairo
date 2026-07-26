import type { RuntimeError } from '@kairo/runtime';
import { err } from '@usersatoshi/results';

import type { AgentExecutorError } from './agent-executor.ts';
import type { CommandRunnerError, RunStoreError } from './ports.ts';

export const enum ExecutorErrorKind {
  RunStore = 0,
  Runtime = 1,
  UnknownNode = 2,
  UnsupportedNode = 3,
  Command = 4,
  InvalidInput = 5,
  Agent = 6,
}

export type ExecutorError =
  | {
      readonly kind: ExecutorErrorKind.RunStore;
      readonly error: RunStoreError;
    }
  | {
      readonly kind: ExecutorErrorKind.Runtime;
      readonly error: RuntimeError;
    }
  | {
      readonly kind: ExecutorErrorKind.UnknownNode;
      readonly nodeId: string;
    }
  | {
      readonly kind: ExecutorErrorKind.UnsupportedNode;
      readonly nodeId: string;
      readonly nodeType: string;
    }
  | {
      readonly kind: ExecutorErrorKind.Command;
      readonly invocationSequence: number;
      readonly error: CommandRunnerError;
    }
  | {
      readonly kind: ExecutorErrorKind.InvalidInput;
      readonly field: string;
      readonly reason: string;
    }
  | {
      readonly kind: ExecutorErrorKind.Agent;
      readonly invocationSequence: number;
      readonly error: AgentExecutorError;
    };

export function toErr<K extends ExecutorError['kind']>(
  kind: K,
  details: Omit<Extract<ExecutorError, { kind: K }>, 'kind'>,
): Extract<ExecutorError, { kind: K }> {
  // The discriminant and mapped details are coupled by the generic signature.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { kind, ...details } as Extract<ExecutorError, { kind: K }>;
}

export function toExecutorError<K extends ExecutorError['kind']>(
  kind: K,
  details: Omit<Extract<ExecutorError, { kind: K }>, 'kind'>,
): ReturnType<typeof err<Extract<ExecutorError, { kind: K }>>> {
  return err(toErr(kind, details));
}
