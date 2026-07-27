import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import {
  ForgejoTicketProvider,
  normalizeForgejoIssueWebhook,
  type TicketFetch,
  validateForgejoWebhookSignature,
} from '@kouro/ticket-provider-forgejo';
import { SqliteTicketSyncStore, TicketProviderErrorKind } from '@kouro/tickets';

interface FakeForgejo {
  readonly fetch: TicketFetch;
  readonly requests: { method: string; path: string; body?: unknown; authorization?: string }[];
  failStatus?: number;
  advertiseWebhooks: boolean;
}

function issue(
  state: 'open' | 'closed' = 'open',
  updatedAt = '2026-07-26T14:00:00Z',
  description = 'Provider-owned description',
): Record<string, unknown> {
  return {
    id: 100,
    number: 7,
    title: 'Forgejo ticket',
    body: description,
    state,
    html_url: 'https://forgejo.test/acme/kouro/issues/7',
    updated_at: updatedAt,
    labels: [{ id: 1, name: 'ticket' }],
    assignees: [{ login: 'satoshi' }],
    milestone: { id: 4, title: 'T4' },
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fakeForgejo(): FakeForgejo {
  const requests: FakeForgejo['requests'] = [];
  const server: FakeForgejo = {
    requests,
    advertiseWebhooks: true,
    fetch: async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      const headers = new Headers(init?.headers);
      requests.push({
        method,
        path: `${url.pathname}${url.search}`,
        body,
        authorization: headers.get('authorization') ?? undefined,
      });
      if (server.failStatus) return new Response('{}', { status: server.failStatus });
      if (url.pathname === '/api/v1/version') {
        return Response.json({ version: '11.0.3+gitea-1.22.0' });
      }
      if (url.pathname === '/swagger.v1.json') {
        return Response.json({
          paths: {
            '/repos/{owner}/{repo}/issues': {},
            '/repos/{owner}/{repo}/issues/{index}/comments': {},
            '/repos/{owner}/{repo}/labels': {},
            '/repos/{owner}/{repo}/assignees': {},
            '/repos/{owner}/{repo}/milestones': {},
            ...(server.advertiseWebhooks ? { '/repos/{owner}/{repo}/hooks': {} } : {}),
          },
        });
      }
      if (url.pathname.endsWith('/labels')) {
        return Response.json([
          { id: 1, name: 'ticket' },
          { id: 2, name: 'synced' },
        ]);
      }
      if (url.pathname.endsWith('/milestones')) {
        return Response.json([{ id: 4, title: 'T4' }]);
      }
      if (url.pathname.endsWith('/comments')) {
        return Response.json({
          id: 55,
          body: isRecord(body) && typeof body.body === 'string' ? body.body : '',
          user: { login: 'kouro' },
          created_at: '2026-07-26T15:00:00Z',
        });
      }
      if (method === 'GET' && url.pathname.endsWith('/issues')) {
        return Response.json([issue()]);
      }
      const state = isRecord(body) && body.state === 'closed' ? 'closed' : 'open';
      const description = isRecord(body) && typeof body.body === 'string' ? body.body : undefined;
      return new Response(JSON.stringify(issue(state, undefined, description)), {
        status: method === 'POST' ? 201 : 200,
      });
    },
  };
  return server;
}

function provider(
  server: FakeForgejo,
  options: {
    readonly instanceUrl?: string;
    readonly metadataStore?: SqliteTicketSyncStore;
    readonly capabilityOverrides?: { readonly webhooks: boolean };
  } = {},
): ForgejoTicketProvider {
  return new ForgejoTicketProvider({
    instanceUrl: options.instanceUrl ?? 'https://forgejo.test/',
    owner: 'acme',
    repository: 'kouro',
    projectId: 'project-1',
    token: 'secret-reference-value',
    fetch: server.fetch,
    metadataStore: options.metadataStore,
    now: () => '2026-07-26T16:00:00.000Z',
    capabilityOverrides: options.capabilityOverrides,
  });
}

describe('T4 Forgejo ticket provider', () => {
  test('implements issue, comment, label, assignee, milestone, and state operations', async () => {
    const server = fakeForgejo();
    const forgejo = provider(server);
    const created = await forgejo.create('project-1', {
      projectId: 'project-1',
      title: 'Forgejo ticket',
      description: 'Provider-owned description',
      labels: ['ticket'],
      assignees: ['satoshi'],
      milestone: 'T4',
      marker: 'kouro-ticket:ticket-1',
    });
    expect(created.unwrap()).toMatchObject({
      title: 'Forgejo ticket',
      description: 'Provider-owned description',
      marker: 'kouro-ticket:ticket-1',
      labels: ['ticket'],
      assignees: ['satoshi'],
      milestone: 'T4',
    });
    const binding = created.unwrap().binding;
    expect((await forgejo.get(binding)).isOk()).toBe(true);
    expect((await forgejo.list('project-1')).unwrap()).toHaveLength(1);
    expect(
      (
        await forgejo.update(binding, {
          title: 'Updated',
          labels: ['synced'],
          assignees: ['satoshi'],
          milestone: 'T4',
          expectedRevision: '2026-07-26T14:00:00Z',
        })
      ).isOk(),
    ).toBe(true);
    expect(
      (
        await forgejo.addComment(binding, {
          author: 'kouro',
          body: 'Run started',
        })
      ).unwrap(),
    ).toMatchObject({ externalId: '55', body: 'Run started' });
    expect((await forgejo.close(binding)).isOk()).toBe(true);
    expect((await forgejo.reopen(binding)).isOk()).toBe(true);

    expect(
      server.requests.some(
        ({ body }) =>
          isRecord(body) &&
          Array.isArray(body.labels) &&
          body.labels[0] === 1 &&
          body.milestone === 4,
      ),
    ).toBe(true);
    expect(
      server.requests.some(
        ({ body }) => body !== undefined && JSON.stringify(body).includes('kouro-ticket'),
      ),
    ).toBe(true);
    expect(
      server.requests.every(
        ({ authorization }) => authorization === 'token secret-reference-value',
      ),
    ).toBe(true);
  });

  test('detects and durably records per-instance version and capabilities', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'kouro-forgejo-metadata-'));
    const path = join(directory, 'kouro.sqlite');
    const metadataStore = new SqliteTicketSyncStore(path);
    try {
      expect(metadataStore.initialize().isOk()).toBe(true);
      const server = fakeForgejo();
      const detected = await provider(server, { metadataStore }).detectInstance();
      expect(detected.unwrap()).toEqual({
        instanceUrl: 'https://forgejo.test',
        version: '11.0.3+gitea-1.22.0',
        apiVersion: 'v1',
        capabilities: {
          issues: true,
          comments: true,
          labels: true,
          assignees: true,
          milestones: true,
          webhooks: true,
          projects: false,
        },
        lastCheckedAt: '2026-07-26T16:00:00.000Z',
      });
      expect(metadataStore.getForgejoMetadata('https://forgejo.test').unwrap()).toEqual(
        detected.unwrap(),
      );

      const otherServer = fakeForgejo();
      otherServer.advertiseWebhooks = false;
      const pollingOnly = provider(otherServer, {
        instanceUrl: 'https://forgejo-two.test',
        metadataStore,
        capabilityOverrides: { webhooks: false },
      });
      expect((await pollingOnly.detectCapabilities()).unwrap().webhooks).toBe(false);
      expect((await pollingOnly.list('project-1')).unwrap()).toHaveLength(1);
      expect(metadataStore.getForgejoMetadata('https://forgejo-two.test').unwrap()).toMatchObject({
        instanceUrl: 'https://forgejo-two.test',
        capabilities: { webhooks: false, issues: true },
      });
    } finally {
      metadataStore.dispose();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('maps provider failures and rejects stale revisions', async () => {
    const server = fakeForgejo();
    const forgejo = provider(server);
    const binding = {
      kind: 'forgejo' as const,
      instanceUrl: 'https://forgejo.test',
      owner: 'acme',
      repository: 'kouro',
      issueNumber: 7,
      externalUrl: 'https://forgejo.test/acme/kouro/issues/7',
    };
    const stale = await forgejo.update(binding, {
      title: 'stale',
      expectedRevision: 'old-revision',
    });
    if (stale.isOk()) throw new Error('Expected stale Forgejo revision to fail');
    expect(stale.error.kind).toBe(TicketProviderErrorKind.Conflict);

    for (const [status, kind] of [
      [401, TicketProviderErrorKind.AuthenticationFailed],
      [403, TicketProviderErrorKind.PermissionDenied],
      [404, TicketProviderErrorKind.NotFound],
      [429, TicketProviderErrorKind.RateLimited],
    ] as const) {
      server.failStatus = status;
      const result = await forgejo.get(binding);
      if (result.isOk()) throw new Error(`Expected Forgejo status ${status} to fail`);
      expect(result.error.kind).toBe(kind);
    }
  });

  test('authenticates and normalizes Forgejo issue webhooks', () => {
    const payload = JSON.stringify({ issue: issue() });
    const secret = 'webhook-secret';
    const signature = createHmac('sha256', secret).update(payload).digest('hex');
    expect(validateForgejoWebhookSignature(payload, signature, secret).unwrap()).toBe(true);
    expect(validateForgejoWebhookSignature(payload, 'bad', secret).unwrap()).toBe(false);
    expect(
      normalizeForgejoIssueWebhook(
        JSON.parse(payload),
        'https://forgejo.test/',
        'acme',
        'kouro',
      ).unwrap(),
    ).toMatchObject({
      binding: {
        kind: 'forgejo',
        instanceUrl: 'https://forgejo.test',
        issueNumber: 7,
      },
      title: 'Forgejo ticket',
      status: 'backlog',
      milestone: 'T4',
    });
  });
});
