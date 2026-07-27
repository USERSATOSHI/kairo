import { type TicketProviderError } from '@kouro/tickets';
import { err } from '@usersatoshi/results';

export function forgejoError(
  error: TicketProviderError,
): ReturnType<typeof err<TicketProviderError>> {
  return err(error);
}
