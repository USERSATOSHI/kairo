import { err } from '@usersatoshi/results';

export const enum RuntimeErrorKind {
  InvalidEventSequence = 0,
  WorkflowChecksumMismatch = 1,
  UnknownNode = 2,
  UnknownInvocation = 3,
  InvalidInvocationSequence = 4,
  InvalidAttemptNumber = 5,
  IllegalStateTransition = 6,
  AmbiguousTransition = 7,
  MissingTransition = 8,
  InvalidExpression = 9,
  UnknownCounter = 10,
  StaleApproval = 11,
}

export type RuntimeError =
  | {
      readonly kind: RuntimeErrorKind.InvalidEventSequence;
      readonly expected: number;
      readonly received: number;
    }
  | {
      readonly kind: RuntimeErrorKind.WorkflowChecksumMismatch;
      readonly expected: string;
      readonly received: string;
    }
  | { readonly kind: RuntimeErrorKind.UnknownNode; readonly nodeId: string }
  | {
      readonly kind: RuntimeErrorKind.UnknownInvocation;
      readonly invocationSequence: number;
    }
  | {
      readonly kind: RuntimeErrorKind.InvalidInvocationSequence;
      readonly expected: number;
      readonly received: number;
    }
  | {
      readonly kind: RuntimeErrorKind.InvalidAttemptNumber;
      readonly invocationSequence: number;
      readonly expected: number;
      readonly received: number;
    }
  | {
      readonly kind: RuntimeErrorKind.IllegalStateTransition;
      readonly entity: string;
      readonly from: string;
      readonly event: string;
    }
  | {
      readonly kind: RuntimeErrorKind.AmbiguousTransition;
      readonly nodeId: string;
      readonly outcome: string;
      readonly transitionIds: readonly string[];
    }
  | {
      readonly kind: RuntimeErrorKind.MissingTransition;
      readonly nodeId: string;
      readonly outcome: string;
    }
  | {
      readonly kind: RuntimeErrorKind.InvalidExpression;
      readonly reason: string;
    }
  | {
      readonly kind: RuntimeErrorKind.UnknownCounter;
      readonly counter: string;
    }
  | {
      readonly kind: RuntimeErrorKind.StaleApproval;
      readonly invocationSequence: number;
      readonly reason: string;
    };

export function toErr<K extends RuntimeError['kind']>(
  kind: K,
  details: Omit<Extract<RuntimeError, { kind: K }>, 'kind'>,
): Extract<RuntimeError, { kind: K }> {
  // The discriminant and mapped details are coupled by the generic signature.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return {
    kind,
    ...details,
  } as Extract<RuntimeError, { kind: K }>;
}

export function toRuntimeError<K extends RuntimeError['kind']>(
  kind: K,
  details: Omit<Extract<RuntimeError, { kind: K }>, 'kind'>,
): ReturnType<typeof err<Extract<RuntimeError, { kind: K }>>> {
  return err(toErr(kind, details));
}
