import { err, type Result } from '@usersatoshi/results';

export const enum CliErrorKind {
  InvalidArguments = 0,
  Initialization = 1,
  Compilation = 2,
  Repository = 3,
  Persistence = 4,
  Lifecycle = 5,
  Serve = 6,
  HarnessUnavailable = 7,
  Scaffolding = 8,
}

export interface CliError {
  readonly kind: CliErrorKind;
  readonly code: string;
  readonly message: string;
}

export function cliErr<T>(kind: CliErrorKind, code: string, message: string): Result<T, CliError> {
  return err({ kind, code, message });
}
