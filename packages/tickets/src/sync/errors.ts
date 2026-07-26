import type { TicketError } from '../errors.ts';
import type { TicketProviderError } from '../provider/types.ts';
import { err } from '@usersatoshi/results';

export const enum TicketSyncErrorKind {
  Ticket = 1,
  Provider = 2,
  InvalidEvent = 3,
  Command = 4,
}

export type TicketSyncError =
  | {
      readonly kind: TicketSyncErrorKind.Ticket;
      readonly error: TicketError;
    }
  | {
      readonly kind: TicketSyncErrorKind.Provider;
      readonly error: TicketProviderError;
    }
  | {
      readonly kind: TicketSyncErrorKind.InvalidEvent;
      readonly reason: string;
    }
  | {
      readonly kind: TicketSyncErrorKind.Command;
      readonly runId: string;
      readonly error: TicketError;
    };

export function toTicketSyncError<K extends TicketSyncError['kind']>(
  kind: K,
  details: Omit<Extract<TicketSyncError, { kind: K }>, 'kind'>,
): ReturnType<typeof err<Extract<TicketSyncError, { kind: K }>>> {
  // The discriminant and mapped details are coupled by the generic signature.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return err({ kind, ...details } as Extract<TicketSyncError, { kind: K }>);
}
