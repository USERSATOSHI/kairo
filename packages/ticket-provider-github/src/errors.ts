import { TicketProviderErrorKind, type TicketProviderError } from '@kouro/tickets';
import { err } from '@usersatoshi/results';

export function githubError(
  kind: TicketProviderErrorKind,
  code: string,
  message: string,
  retryAfter?: string,
): ReturnType<typeof err<TicketProviderError>> {
  return err({
    kind,
    code,
    message,
    ...(retryAfter === undefined ? {} : { retryAfter }),
  });
}
