import { describe, expect, test } from 'bun:test';

import type { TicketProvider } from '@kairo/executors';

export interface TicketProviderContractHarness {
  readonly provider: TicketProvider;
  readonly reference: string;
}

export function ticketProviderContract(
  name: string,
  createHarness: () => TicketProviderContractHarness,
): void {
  describe(`${name} TicketProvider contract`, () => {
    test('resolves a source revision and normalized ticket identity', async () => {
      const { provider, reference } = createHarness();
      expect(provider.id.trim()).not.toBe('');
      const resolved = await provider.resolve(reference);
      expect(resolved.isOk()).toBe(true);
      const ticket = resolved.unwrap();
      expect(ticket.reference.trim()).not.toBe('');
      expect(ticket.revision.trim()).not.toBe('');
      expect(ticket.title.trim()).not.toBe('');
      expect(ticket.description.trim()).not.toBe('');
    });
  });
}
