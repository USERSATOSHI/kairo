import { err, type Result } from '@usersatoshi/results';

export const enum ApiErrorKind {
  NotFound = 0,
  InvalidInput = 1,
  Conflict = 2,
  Persistence = 3,
  ArtifactRead = 4,
}

export interface ApiError {
  readonly kind: ApiErrorKind;
  readonly code: string;
  readonly message: string;
}

export function apiErr<T>(kind: ApiErrorKind, code: string, message: string): Result<T, ApiError> {
  return err({ kind, code, message });
}
