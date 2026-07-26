import { err } from '@usersatoshi/results';

import type { TicketError } from '../errors.ts';
import type { TicketProviderError } from '../provider/types.ts';

export const enum TicketMigrationErrorKind {
  Ticket = 1,
  Provider = 2,
  InvalidSource = 3,
  Conflict = 4,
  VerificationFailed = 5,
}

export type TicketMigrationError =
  | {
      readonly kind: TicketMigrationErrorKind.Ticket;
      readonly error: TicketError;
    }
  | {
      readonly kind: TicketMigrationErrorKind.Provider;
      readonly error: TicketProviderError;
    }
  | {
      readonly kind: TicketMigrationErrorKind.InvalidSource;
      readonly ticketId: string;
      readonly reason: string;
    }
  | {
      readonly kind: TicketMigrationErrorKind.Conflict;
      readonly ticketId: string;
      readonly reason: string;
    }
  | {
      readonly kind: TicketMigrationErrorKind.VerificationFailed;
      readonly ticketId: string;
      readonly reason: string;
    };

export function toTicketMigrationError<K extends TicketMigrationError['kind']>(
  kind: K,
  details: Omit<Extract<TicketMigrationError, { kind: K }>, 'kind'>,
): ReturnType<typeof err<Extract<TicketMigrationError, { kind: K }>>> {
  // The discriminant and mapped details are coupled by the generic signature.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return err({ kind, ...details } as Extract<TicketMigrationError, { kind: K }>);
}
