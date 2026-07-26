import { err } from '@usersatoshi/results';

export const enum TicketErrorKind {
  InvalidInput = 1,
  NotFound = 2,
  AlreadyExists = 3,
  RevisionConflict = 4,
  InvalidStatusTransition = 5,
  RelationshipConflict = 6,
  DatabaseFailure = 7,
}

export type TicketError =
  | {
      readonly kind: TicketErrorKind.InvalidInput;
      readonly field: string;
      readonly reason: string;
    }
  | {
      readonly kind: TicketErrorKind.NotFound;
      readonly ticketId: string;
    }
  | {
      readonly kind: TicketErrorKind.AlreadyExists;
      readonly ticketId: string;
    }
  | {
      readonly kind: TicketErrorKind.RevisionConflict;
      readonly ticketId: string;
      readonly expected: number;
      readonly actual: number;
    }
  | {
      readonly kind: TicketErrorKind.InvalidStatusTransition;
      readonly ticketId: string;
      readonly from: string;
      readonly to: string;
    }
  | {
      readonly kind: TicketErrorKind.RelationshipConflict;
      readonly sourceTicketId: string;
      readonly targetTicketId: string;
      readonly reason: string;
    }
  | {
      readonly kind: TicketErrorKind.DatabaseFailure;
      readonly operation: string;
      readonly message: string;
    };

export function toErr<K extends TicketError['kind']>(
  kind: K,
  details: Omit<Extract<TicketError, { kind: K }>, 'kind'>,
): Extract<TicketError, { kind: K }> {
  // The discriminant and mapped details are coupled by the generic signature.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return { kind, ...details } as Extract<TicketError, { kind: K }>;
}

export function toTicketError<K extends TicketError['kind']>(
  kind: K,
  details: Omit<Extract<TicketError, { kind: K }>, 'kind'>,
): ReturnType<typeof err<Extract<TicketError, { kind: K }>>> {
  return err(toErr(kind, details));
}
