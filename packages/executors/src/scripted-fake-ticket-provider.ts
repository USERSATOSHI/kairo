import { ok, type Result } from '@usersatoshi/results';

import type { ResolvedTicket, TicketProvider, TicketProviderError } from './ports.ts';

export type ScriptedTicketResult = Result<ResolvedTicket, TicketProviderError>;

function isScriptedResult(
  item: ScriptedTicketResult | ResolvedTicket,
): item is ScriptedTicketResult {
  return (
    item !== null && typeof item === 'object' && 'isErr' in item && typeof item.isErr === 'function'
  );
}

export class ScriptedFakeTicketProvider implements TicketProvider {
  readonly references: string[] = [];
  private readonly script: ScriptedTicketResult[];

  constructor(
    readonly id: string,
    script: readonly (ScriptedTicketResult | ResolvedTicket)[],
  ) {
    this.script = script.map((item) => (isScriptedResult(item) ? item : ok(item)));
  }

  resolve(reference: string): Promise<ScriptedTicketResult> {
    this.references.push(reference);
    const scripted = this.script.shift();
    if (!scripted) {
      throw new Error(`No scripted ticket result remains for provider: ${this.id}`);
    }
    return Promise.resolve(scripted);
  }
}
