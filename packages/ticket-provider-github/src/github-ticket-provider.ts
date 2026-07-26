import {
  TicketProviderErrorKind,
  type AddTicketCommentInput,
  type ProjectId,
  type ProviderComment,
  type ProviderCreateTicketInput,
  type ProviderTicket,
  type ProviderUpdateTicketInput,
  type TicketBinding,
  type TicketProvider,
  type TicketProviderCapabilities,
  type TicketProviderError,
} from '@kairo/tickets';
import { fromAsync, ok, safeCall, type Result } from '@usersatoshi/results';

import { githubError } from './errors.ts';

export interface GitHubTicketProviderOptions {
  readonly owner: string;
  readonly repository: string;
  readonly projectId: string;
  readonly token: string;
  readonly apiUrl?: string;
  readonly fetch?: TicketFetch;
}

export interface TicketFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

interface GitHubResponse {
  readonly body: unknown;
  readonly headers: Headers;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function responseError(response: Response): Result<never, TicketProviderError> {
  const retryAfter = response.headers.get('retry-after') ?? undefined;
  if (response.status === 401) {
    return githubError(
      TicketProviderErrorKind.AuthenticationFailed,
      'github_authentication_failed',
      'GitHub rejected the configured credential',
    );
  }
  if (response.status === 404) {
    return githubError(
      TicketProviderErrorKind.NotFound,
      'github_issue_not_found',
      'GitHub issue was not found',
    );
  }
  if (
    response.status === 429 ||
    (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0')
  ) {
    return githubError(
      TicketProviderErrorKind.RateLimited,
      'github_rate_limited',
      'GitHub rate limit was exceeded',
      retryAfter,
    );
  }
  if (response.status === 403) {
    return githubError(
      TicketProviderErrorKind.PermissionDenied,
      'github_permission_denied',
      'GitHub denied the requested issue operation',
    );
  }
  if (response.status === 409 || response.status === 412 || response.status === 422) {
    return githubError(
      TicketProviderErrorKind.Conflict,
      'github_issue_conflict',
      'GitHub rejected a conflicting issue update',
    );
  }
  return githubError(
    TicketProviderErrorKind.Unavailable,
    'github_unavailable',
    `GitHub request failed with status ${response.status}`,
    retryAfter,
  );
}

function stringsFromObjects(value: unknown, key: string): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    isRecord(item) && typeof item[key] === 'string' ? [item[key]] : [],
  );
}

function etagHeaders(revision: string | undefined): HeadersInit | undefined {
  return revision?.includes('"') ? { 'if-match': revision } : undefined;
}

function githubIssue(
  value: unknown,
  owner: string,
  repository: string,
  revisionHeader?: string,
): Result<ProviderTicket, TicketProviderError> {
  if (
    !isRecord(value) ||
    typeof value.number !== 'number' ||
    typeof value.title !== 'string' ||
    (value.body !== null && typeof value.body !== 'string') ||
    (value.state !== 'open' && value.state !== 'closed') ||
    typeof value.html_url !== 'string' ||
    typeof value.updated_at !== 'string'
  ) {
    return githubError(
      TicketProviderErrorKind.InvalidResponse,
      'github_invalid_issue',
      'GitHub returned a malformed issue',
    );
  }
  const milestone =
    isRecord(value.milestone) && typeof value.milestone.title === 'string'
      ? value.milestone.title
      : undefined;
  return ok({
    binding: {
      kind: 'github',
      owner,
      repository,
      issueNumber: value.number,
      externalUrl: value.html_url,
      lastSyncedRevision: revisionHeader ?? value.updated_at,
    },
    title: value.title,
    description: value.body ?? '',
    status: value.state === 'closed' ? 'done' : 'backlog',
    labels: stringsFromObjects(value.labels, 'name'),
    assignees: stringsFromObjects(value.assignees, 'login'),
    ...(milestone === undefined ? {} : { milestone }),
    revision: revisionHeader ?? value.updated_at,
    updatedAt: value.updated_at,
  });
}

export class GitHubTicketProvider implements TicketProvider {
  readonly kind = 'github' as const;

  private readonly apiUrl: string;
  private readonly requestFetch: TicketFetch;

  constructor(private readonly options: GitHubTicketProviderOptions) {
    this.apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.requestFetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async get(binding: TicketBinding): Promise<Result<ProviderTicket, TicketProviderError>> {
    if (
      binding.kind !== 'github' ||
      binding.owner !== this.options.owner ||
      binding.repository !== this.options.repository
    ) {
      return githubError(
        TicketProviderErrorKind.Conflict,
        'github_binding_mismatch',
        'Ticket binding does not belong to this GitHub connection',
      );
    }
    const response = await this.request(
      `/repos/${encodeURIComponent(binding.owner)}/${encodeURIComponent(binding.repository)}/issues/${binding.issueNumber}`,
    );
    return response.isErr()
      ? response
      : githubIssue(
          response.unwrap().body,
          binding.owner,
          binding.repository,
          response.unwrap().headers.get('etag') ?? undefined,
        );
  }

  async list(
    projectId: ProjectId,
  ): Promise<Result<readonly ProviderTicket[], TicketProviderError>> {
    if (projectId !== this.options.projectId) {
      return githubError(
        TicketProviderErrorKind.Conflict,
        'github_project_mismatch',
        'Project does not belong to this GitHub connection',
      );
    }
    const response = await this.request(
      `/repos/${encodeURIComponent(this.options.owner)}/${encodeURIComponent(this.options.repository)}/issues?state=all&per_page=100`,
    );
    if (response.isErr()) return response;
    const body = response.unwrap().body;
    if (!Array.isArray(body)) {
      return githubError(
        TicketProviderErrorKind.InvalidResponse,
        'github_invalid_issue_list',
        'GitHub returned a malformed issue list',
      );
    }
    const tickets: ProviderTicket[] = [];
    for (const issue of body) {
      if (isRecord(issue) && 'pull_request' in issue) continue;
      const normalized = githubIssue(issue, this.options.owner, this.options.repository);
      if (normalized.isErr()) return normalized;
      tickets.push(normalized.unwrap());
    }
    return ok(tickets);
  }

  async create(
    projectId: ProjectId,
    input: ProviderCreateTicketInput,
  ): Promise<Result<ProviderTicket, TicketProviderError>> {
    if (projectId !== this.options.projectId) {
      return githubError(
        TicketProviderErrorKind.Conflict,
        'github_project_mismatch',
        'Project does not belong to this GitHub connection',
      );
    }
    const body = input.marker
      ? `${input.description}\n\n<!-- ${input.marker} -->`
      : input.description;
    const response = await this.request(
      `/repos/${encodeURIComponent(this.options.owner)}/${encodeURIComponent(this.options.repository)}/issues`,
      {
        method: 'POST',
        body: JSON.stringify({
          title: input.title,
          body,
          labels: input.labels ?? [],
          assignees: input.assignees ?? [],
        }),
      },
    );
    return response.isErr()
      ? response
      : githubIssue(
          response.unwrap().body,
          this.options.owner,
          this.options.repository,
          response.unwrap().headers.get('etag') ?? undefined,
        );
  }

  async update(
    binding: TicketBinding,
    input: ProviderUpdateTicketInput,
  ): Promise<Result<ProviderTicket, TicketProviderError>> {
    if (binding.kind !== 'github') {
      return githubError(
        TicketProviderErrorKind.Conflict,
        'github_binding_mismatch',
        'A GitHub binding is required',
      );
    }
    const response = await this.request(
      `/repos/${encodeURIComponent(binding.owner)}/${encodeURIComponent(binding.repository)}/issues/${binding.issueNumber}`,
      {
        method: 'PATCH',
        headers: etagHeaders(input.expectedRevision),
        body: JSON.stringify({
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.description === undefined ? {} : { body: input.description }),
          ...(input.labels === undefined ? {} : { labels: input.labels }),
          ...(input.assignees === undefined ? {} : { assignees: input.assignees }),
        }),
      },
    );
    return response.isErr()
      ? response
      : githubIssue(
          response.unwrap().body,
          binding.owner,
          binding.repository,
          response.unwrap().headers.get('etag') ?? undefined,
        );
  }

  async addComment(
    binding: TicketBinding,
    input: AddTicketCommentInput,
  ): Promise<Result<ProviderComment, TicketProviderError>> {
    if (binding.kind !== 'github') {
      return githubError(
        TicketProviderErrorKind.Conflict,
        'github_binding_mismatch',
        'A GitHub binding is required',
      );
    }
    const response = await this.request(
      `/repos/${encodeURIComponent(binding.owner)}/${encodeURIComponent(binding.repository)}/issues/${binding.issueNumber}/comments`,
      { method: 'POST', body: JSON.stringify({ body: input.body }) },
    );
    if (response.isErr()) return response;
    const value = response.unwrap().body;
    if (
      !isRecord(value) ||
      (typeof value.id !== 'number' && typeof value.id !== 'string') ||
      typeof value.body !== 'string' ||
      typeof value.created_at !== 'string'
    ) {
      return githubError(
        TicketProviderErrorKind.InvalidResponse,
        'github_invalid_comment',
        'GitHub returned a malformed issue comment',
      );
    }
    const author =
      isRecord(value.user) && typeof value.user.login === 'string'
        ? value.user.login
        : input.author;
    return ok({
      externalId: String(value.id),
      author,
      body: value.body,
      createdAt: value.created_at,
      ...(typeof value.updated_at === 'string' ? { updatedAt: value.updated_at } : {}),
    });
  }

  close(binding: TicketBinding): Promise<Result<void, TicketProviderError>> {
    return this.changeState(binding, 'closed');
  }

  reopen(binding: TicketBinding): Promise<Result<void, TicketProviderError>> {
    return this.changeState(binding, 'open');
  }

  detectCapabilities(): Promise<Result<TicketProviderCapabilities, TicketProviderError>> {
    return Promise.resolve(
      ok({
        issues: true,
        comments: true,
        labels: true,
        assignees: true,
        milestones: true,
        webhooks: true,
        projects: false,
      }),
    );
  }

  private async changeState(
    binding: TicketBinding,
    state: 'open' | 'closed',
  ): Promise<Result<void, TicketProviderError>> {
    if (binding.kind !== 'github') {
      return githubError(
        TicketProviderErrorKind.Conflict,
        'github_binding_mismatch',
        'A GitHub binding is required',
      );
    }
    const response = await this.request(
      `/repos/${encodeURIComponent(binding.owner)}/${encodeURIComponent(binding.repository)}/issues/${binding.issueNumber}`,
      {
        method: 'PATCH',
        headers: etagHeaders(binding.lastSyncedRevision),
        body: JSON.stringify({ state }),
      },
    );
    return response.isErr() ? response : ok(undefined);
  }

  private async request(
    path: string,
    init: RequestInit = {},
  ): Promise<Result<GitHubResponse, TicketProviderError>> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/vnd.github+json');
    headers.set('authorization', `Bearer ${this.options.token}`);
    headers.set('content-type', 'application/json');
    headers.set('user-agent', 'kairo-ticket-provider');
    const response = await fromAsync(
      () =>
        this.requestFetch(`${this.apiUrl}${path}`, {
          ...init,
          headers,
        }),
      () =>
        ({
          kind: TicketProviderErrorKind.Unavailable,
          code: 'github_unavailable',
          message: 'GitHub could not be reached',
        }) satisfies TicketProviderError,
    );
    if (response.isErr()) return response;
    if (!response.unwrap().ok) return responseError(response.unwrap());
    if (response.unwrap().status === 204) {
      return ok({ body: undefined, headers: response.unwrap().headers });
    }
    const text = await fromAsync(
      () => response.unwrap().text(),
      () =>
        ({
          kind: TicketProviderErrorKind.InvalidResponse,
          code: 'github_response_read_failed',
          message: 'GitHub response could not be read',
        }) satisfies TicketProviderError,
    );
    if (text.isErr()) return text;
    const parsed = safeCall(
      (): unknown => JSON.parse(text.unwrap()),
      () =>
        ({
          kind: TicketProviderErrorKind.InvalidResponse,
          code: 'github_invalid_json',
          message: 'GitHub returned invalid JSON',
        }) satisfies TicketProviderError,
    );
    return parsed.isErr()
      ? parsed
      : ok({ body: parsed.unwrap(), headers: response.unwrap().headers });
  }
}
