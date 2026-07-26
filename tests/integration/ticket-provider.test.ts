import { ScriptedFakeTicketProvider } from '@kairo/executors';

import { ticketProviderContract } from '../contracts/ticket-provider.contract.ts';

ticketProviderContract('ScriptedFakeTicketProvider', () => ({
  provider: new ScriptedFakeTicketProvider('fake-kanban', [
    {
      reference: 'ENG-123',
      revision: '42',
      title: 'Add ticket inputs',
      description: 'Bind the requested change to the run.',
    },
  ]),
  reference: 'ENG-123',
}));
