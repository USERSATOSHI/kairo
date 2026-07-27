import { createHmac } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import {
  GitHubTicketProvider,
  normalizeGitHubIssueWebhook,
  type TicketFetch,
  validateGitHubWebhookSignature,
} from '@kouro/ticket-provider-github';
import { TicketProviderErrorKind } from '@kouro/tickets';

interface FakeGitHub {
  readonly fetch: TicketFetch;
  readonly requests: { method: string; path: string; body?: unknown }[];
  failStatus?: number;
}

function issue(
  state: 'open' | 'closed' = 'open',
  description = 'Provider-owned description',
): Record<string, unknown> {
  return {
    id: 100,
    number: 7,
    title: 'GitHub ticket',
    body: description,
    state,
    html_url: 'https://github.test/acme/kouro/issues/7',
    updated_at: state === 'open' ? '2026-07-26T10:00:00Z' : '2026-07-26T11:00:00Z',
    labels: [{ name: 'ticket' }],
    assignees: [{ login: 'satoshi' }],
    milestone: { title: 'T3' },
  };
}

function fakeGitHub(): FakeGitHub {
  const requests: FakeGitHub['requests'] = [];
  const server: FakeGitHub = {
    requests,
    fetch: async (input, init) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
      const method = init?.method ?? 'GET';
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      requests.push({ method, path: `${url.pathname}${url.search}`, body });
      if (server.failStatus) {
        return new Response('{}', {
          status: server.failStatus,
          headers: server.failStatus === 403 ? { 'x-ratelimit-remaining': '0' } : {},
        });
      }
      if (url.pathname.endsWith('/comments')) {
        return Response.json({
          id: 55,
          body: isRecord(body) && typeof body.body === 'string' ? body.body : '',
          user: { login: 'kouro' },
          created_at: '2026-07-26T12:00:00Z',
        });
      }
      const requestedState = isRecord(body) && body.state === 'closed' ? 'closed' : 'open';
      if (method === 'GET' && url.pathname.endsWith('/issues')) {
        return Response.json([issue()]);
      }
      const description = isRecord(body) && typeof body.body === 'string' ? body.body : undefined;
      return new Response(JSON.stringify(issue(requestedState, description)), {
        status: method === 'POST' ? 201 : 200,
        headers: { etag: '"revision-7"' },
      });
    },
  };
  return server;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function provider(server: FakeGitHub): GitHubTicketProvider {
  return new GitHubTicketProvider({
    owner: 'acme',
    repository: 'kouro',
    projectId: 'project-1',
    token: 'secret-reference-value',
    apiUrl: 'https://api.github.test',
    fetch: server.fetch,
  });
}

describe('T3 GitHub ticket provider', () => {
  test('implements issue, comment, label, assignee, milestone, and state operations', async () => {
    const server = fakeGitHub();
    const github = provider(server);
    const created = await github.create('project-1', {
      projectId: 'project-1',
      title: 'GitHub ticket',
      description: 'Provider-owned description',
      labels: ['ticket'],
      assignees: ['satoshi'],
      marker: 'kouro-ticket:ticket-1',
    });
    const binding = created.unwrap().binding;
    expect(created.unwrap()).toMatchObject({
      title: 'GitHub ticket',
      description: 'Provider-owned description',
      marker: 'kouro-ticket:ticket-1',
      labels: ['ticket'],
      assignees: ['satoshi'],
      milestone: 'T3',
      revision: '"revision-7"',
    });
    expect((await github.get(binding)).isOk()).toBe(true);
    expect((await github.list('project-1')).unwrap()).toHaveLength(1);
    expect(
      (
        await github.update(binding, {
          title: 'Updated',
          labels: ['synced'],
          expectedRevision: '"revision-7"',
        })
      ).isOk(),
    ).toBe(true);
    expect(
      (
        await github.addComment(binding, {
          author: 'kouro',
          body: 'Run started',
        })
      ).unwrap(),
    ).toMatchObject({ externalId: '55', body: 'Run started' });
    expect((await github.close(binding)).isOk()).toBe(true);
    expect((await github.reopen(binding)).isOk()).toBe(true);
    expect((await github.detectCapabilities()).unwrap()).toEqual({
      issues: true,
      comments: true,
      labels: true,
      assignees: true,
      milestones: true,
      webhooks: true,
      projects: false,
    });
    expect(server.requests.some(({ body }) => JSON.stringify(body).includes('kouro-ticket'))).toBe(
      true,
    );
  });

  test('maps authentication, rate-limit, and not-found responses to stable errors', async () => {
    const server = fakeGitHub();
    const github = provider(server);
    const binding = {
      kind: 'github' as const,
      owner: 'acme',
      repository: 'kouro',
      issueNumber: 7,
      externalUrl: 'https://github.test/acme/kouro/issues/7',
    };
    for (const [status, kind] of [
      [401, TicketProviderErrorKind.AuthenticationFailed],
      [403, TicketProviderErrorKind.RateLimited],
      [404, TicketProviderErrorKind.NotFound],
    ] as const) {
      server.failStatus = status;
      const result = await github.get(binding);
      if (result.isOk()) throw new Error(`Expected GitHub status ${status} to fail`);
      expect(result.error.kind).toBe(kind);
    }
  });

  test('validates and normalizes GitHub issue webhooks', () => {
    const payload = JSON.stringify({ issue: issue() });
    const secret = 'webhook-secret';
    const signature = `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;
    expect(validateGitHubWebhookSignature(payload, signature, secret).unwrap()).toBe(true);
    expect(validateGitHubWebhookSignature(payload, 'sha256=bad', secret).unwrap()).toBe(false);
    expect(
      normalizeGitHubIssueWebhook(JSON.parse(payload), 'acme', 'kouro').unwrap(),
    ).toMatchObject({
      binding: { kind: 'github', issueNumber: 7 },
      title: 'GitHub ticket',
      status: 'backlog',
    });
  });
});
