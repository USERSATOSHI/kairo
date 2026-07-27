import type { HarnessError } from '@kouro/executors';
import { HarnessErrorKind } from '@kouro/executors';

export function processFailure(message: string): HarnessError {
  return {
    kind: HarnessErrorKind.ProcessFailure,
    message,
  };
}

export function invalidResponse(message: string, transcript: string): HarnessError {
  return {
    kind: HarnessErrorKind.InvalidResponse,
    message,
    transcript,
  };
}
