import { err } from '@usersatoshi/results';

export const enum SandboxErrorKind {
  NotInitialized = 0,
  InvalidIdentifier = 1,
  GitFailure = 2,
  FilesystemFailure = 3,
  RegistrationConflict = 4,
  RepositoryMismatch = 5,
  StartingCommitMismatch = 6,
  WorktreeConflict = 7,
  DirtyWorktree = 8,
  HeadConflict = 9,
  TreeConflict = 10,
  LockTimeout = 11,
  CorruptMetadata = 12,
  RuntimeUnavailable = 13,
  BoundaryViolation = 14,
  CommandFailure = 15,
}

export type SandboxError =
  | {
      readonly kind: SandboxErrorKind.NotInitialized;
    }
  | {
      readonly kind: SandboxErrorKind.InvalidIdentifier;
      readonly field: 'repositoryId' | 'runId';
      readonly value: string;
    }
  | {
      readonly kind: SandboxErrorKind.GitFailure;
      readonly operation: string;
      readonly exitCode: number;
      readonly message: string;
    }
  | {
      readonly kind: SandboxErrorKind.FilesystemFailure;
      readonly operation: string;
      readonly message: string;
      readonly code?: string;
    }
  | {
      readonly kind: SandboxErrorKind.RegistrationConflict;
      readonly repositoryId: string;
    }
  | {
      readonly kind: SandboxErrorKind.RepositoryMismatch;
      readonly repositoryId: string;
      readonly expected: string;
      readonly received: string;
    }
  | {
      readonly kind: SandboxErrorKind.StartingCommitMismatch;
      readonly runId: string;
      readonly startingCommit: string;
      readonly head: string;
    }
  | {
      readonly kind: SandboxErrorKind.WorktreeConflict;
      readonly runId: string;
      readonly path: string;
      readonly reason: string;
    }
  | {
      readonly kind: SandboxErrorKind.DirtyWorktree;
      readonly runId: string;
    }
  | {
      readonly kind: SandboxErrorKind.HeadConflict;
      readonly runId: string;
      readonly expected: string;
      readonly received: string;
    }
  | {
      readonly kind: SandboxErrorKind.TreeConflict;
      readonly runId: string;
      readonly expected: string;
      readonly received: string;
    }
  | {
      readonly kind: SandboxErrorKind.LockTimeout;
      readonly repositoryId: string;
    }
  | {
      readonly kind: SandboxErrorKind.CorruptMetadata;
      readonly path: string;
    }
  | {
      readonly kind: SandboxErrorKind.RuntimeUnavailable;
      readonly runtime: string;
      readonly message: string;
    }
  | {
      readonly kind: SandboxErrorKind.BoundaryViolation;
      readonly operation: 'read' | 'write' | 'execute';
      readonly root: string;
      readonly path: string;
      readonly reason: string;
    }
  | {
      readonly kind: SandboxErrorKind.CommandFailure;
      readonly operation: string;
      readonly message: string;
    };

export function toErr<K extends SandboxError['kind']>(
  kind: K,
  details: Omit<Extract<SandboxError, { kind: K }>, 'kind'>,
): Extract<SandboxError, { kind: K }> {
  // The discriminant and mapped details are coupled by the generic signature.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { kind, ...details } as Extract<SandboxError, { kind: K }>;
}

export function toSandboxError<K extends SandboxError['kind']>(
  kind: K,
  details: Omit<Extract<SandboxError, { kind: K }>, 'kind'>,
): ReturnType<typeof err<Extract<SandboxError, { kind: K }>>> {
  return err(toErr(kind, details));
}
