import type { HarnessError } from '@kairo/executors';
import { HarnessErrorKind } from '@kairo/executors';

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
