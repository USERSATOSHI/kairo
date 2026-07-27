import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import {
  SqliteTicketRepository,
  SqliteTicketSyncStore,
  TicketSyncService,
  type TicketClock,
  type TicketIdGenerator,
} from '@kouro/tickets';
import { GitHubTicketProvider, type TicketFetch } from '@kouro/ticket-provider-github';

function issue(title = 'Imported issue'): Record<string, unknown> {
  return {
    id: 1,
    number: 1,
    title,
    body: 'Synced body',
    state: 'open',
    html_url: 'https://github.test/acme/kouro/issues/1',
    updated_at: title === 'Imported issue' ? 'revision-1' : 'revision-2',
    labels: [{ name: 'sync' }],
    assignees: [],
  };
}

class Clock implements TicketClock {
  now(): string {
    return '2026-07-26T12:00:00.000Z';
  }
}

class Ids implements TicketIdGenerator {
  ticketId(): string {
    return 'ticket-imported';
  }
  commentId(): string {
    return 'comment-imported';
  }
}

describe('T3 ticket synchronization', () => {
  test('imports, polls, deduplicates webhooks, and emits idempotent run comments', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kouro-ticket-sync-'));
    const path = join(directory, 'kouro.sqlite');
    const tickets = new SqliteTicketRepository(path);
    const sync = new SqliteTicketSyncStore(path);
    let current = issue();
    let comments = 0;
    const requestFetch: TicketFetch = async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      if (url.pathname.endsWith('/comments')) {
        comments += 1;
        return Response.json({
          id: comments,
          body: 'run started for Kouro run run-1',
          user: { login: 'kouro' },
          created_at: '2026-07-26T12:00:00Z',
        });
      }
      if ((init?.method ?? 'GET') === 'GET' && url.pathname.endsWith('/issues')) {
        return Response.json([current]);
      }
      return Response.json(current);
    };
    const github = new GitHubTicketProvider({
      owner: 'acme',
      repository: 'kouro',
      projectId: 'project-1',
      token: 'token',
      apiUrl: 'https://api.github.test',
      fetch: requestFetch,
    });
    try {
      expect(tickets.initialize().isOk()).toBe(true);
      expect(sync.initialize().isOk()).toBe(true);
      const service = new TicketSyncService(tickets, sync, new Clock(), new Ids());
      const imported = await service.importProject('project-1', github);
      expect(imported.unwrap()[0]).toMatchObject({
        id: 'ticket-imported',
        title: 'Imported issue',
        binding: { kind: 'github', issueNumber: 1 },
      });
      const importedTicket = imported.unwrap()[0];
      if (!importedTicket) throw new Error('Expected imported ticket');

      current = issue('Changed remotely');
      expect((await service.reconcile('ticket-imported', github)).unwrap()).toMatchObject({
        title: 'Changed remotely',
        revision: 2,
      });

      const normalized = (await github.get(importedTicket.binding)).unwrap();
      expect(
        (
          await service.applyWebhook(
            'delivery-1',
            'issues',
            JSON.stringify({ issue: current }),
            normalized,
          )
        ).unwrap(),
      ).toBe(true);
      expect(
        (
          await service.applyWebhook(
            'delivery-1',
            'issues',
            JSON.stringify({ issue: current }),
            normalized,
          )
        ).unwrap(),
      ).toBe(false);

      const event = {
        sequence: 10,
        type: 'run_started' as const,
        runId: 'run-1',
      };
      expect((await service.syncRunEvent('ticket-imported', github, event, false)).isOk()).toBe(
        true,
      );
      expect((await service.syncRunEvent('ticket-imported', github, event, false)).isOk()).toBe(
        true,
      );
      expect(comments).toBe(1);
      expect(sync.getSyncState('ticket-imported').unwrap().status).toBe('succeeded');
    } finally {
      sync.dispose();
      tickets.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
