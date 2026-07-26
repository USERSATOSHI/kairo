import { treaty } from '@elysiajs/eden';
import { BunCommandRunner, RunCoordinator } from '@kairo/executors';
import { SqliteEventStore } from '@kairo/persistence-sqlite';
import {
  SqliteTicketRepository,
  SqliteTicketRunStore,
  SqliteTicketSyncStore,
} from '@kairo/tickets';
import { err, ok, type Result } from '@usersatoshi/results';

import { createKairoApp, type KairoApp } from './app.ts';
import { LocalArtifactContentReader } from './local-artifact-content-reader.ts';
import { KairoTicketRunQuery } from './ticket-run-query.ts';

export interface ComposedKairoApp {
  readonly app: KairoApp;
  dispose(): void;
}

export interface CompositionError {
  readonly kind: 0;
  readonly message: string;
}

/** Composes the single-process MVP with SQLite and a local command runner. */
export function composeKairoApp(
  databasePath: string,
  artifactRoot?: string,
): Result<ComposedKairoApp, CompositionError> {
  const store = new SqliteEventStore(databasePath);
  const initialized = store.initialize();
  if (initialized.isErr()) {
    store.dispose();
    return err({ kind: 0, message: 'The SQLite run store could not be initialized' });
  }
  const coordinator = new RunCoordinator(store, new BunCommandRunner(process.cwd()));
  const tickets = new SqliteTicketRepository(databasePath);
  const ticketRuns = new SqliteTicketRunStore(databasePath);
  const ticketSync = new SqliteTicketSyncStore(databasePath);
  for (const initializedTickets of [
    tickets.initialize(),
    ticketRuns.initialize(),
    ticketSync.initialize(),
  ]) {
    if (initializedTickets.isErr()) {
      ticketSync.dispose();
      ticketRuns.dispose();
      tickets.dispose();
      store.dispose();
      return err({ kind: 0, message: 'The SQLite ticket stores could not be initialized' });
    }
  }
  return ok({
    app: createKairoApp({
      runs: store,
      coordinator,
      ...(artifactRoot ? { artifacts: new LocalArtifactContentReader(artifactRoot) } : {}),
      tickets: {
        repository: tickets,
        runs: ticketRuns,
        runQuery: new KairoTicketRunQuery(store),
        sync: ticketSync,
      },
    }),
    dispose(): void {
      ticketSync.dispose();
      ticketRuns.dispose();
      tickets.dispose();
      store.dispose();
    },
  });
}

/** Creates the typed Eden client consumed by the dashboard. */
export function createKairoClient(baseUrl: string) {
  return treaty<KairoApp>(baseUrl);
}
