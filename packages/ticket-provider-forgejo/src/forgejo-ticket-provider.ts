import {
  normalizeProviderDescription,
  TicketProviderErrorKind,
  type AddTicketCommentInput,
  type ForgejoInstanceMetadata,
  type ForgejoMetadataStore,
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

import { forgejoError } from './errors.ts';

export interface TicketFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

export interface ForgejoTicketProviderOptions {
  readonly instanceUrl: string;
  readonly owner: string;
  readonly repository: string;
  readonly projectId: string;
  readonly token: string;
  readonly fetch?: TicketFetch;
  readonly metadataStore?: ForgejoMetadataStore;
  readonly now?: () => string;
  readonly capabilityOverrides?: Partial<TicketProviderCapabilities>;
}

interface ForgejoResponse {
  readonly body: unknown;
  readonly headers: Headers;
}

interface NamedResource {
  readonly id: number;
  readonly name: string;
}

const unavailableCapabilities: TicketProviderCapabilities = {
  issues: true,
  comments: true,
  labels: true,
  assignees: true,
  milestones: true,
  webhooks: false,
  projects: false,
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeInstanceUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

function providerError(
  kind: TicketProviderErrorKind,
  code: string,
  message: string,
  retryAfter?: string,
): Result<never, TicketProviderError> {
  return forgejoError({
    kind,
    code,
    message,
    ...(retryAfter === undefined ? {} : { retryAfter }),
  });
}

function responseError(response: Response): Result<never, TicketProviderError> {
  const retryAfter = response.headers.get('retry-after') ?? undefined;
  if (response.status === 401) {
    return providerError(
      TicketProviderErrorKind.AuthenticationFailed,
      'forgejo_authentication_failed',
      'Forgejo rejected the configured credential',
    );
  }
  if (response.status === 404) {
    return providerError(
      TicketProviderErrorKind.NotFound,
      'forgejo_resource_not_found',
      'Forgejo resource was not found',
    );
  }
  if (response.status === 429) {
    return providerError(
      TicketProviderErrorKind.RateLimited,
      'forgejo_rate_limited',
      'Forgejo rate limit was exceeded',
      retryAfter,
    );
  }
  if (response.status === 403) {
    return providerError(
      TicketProviderErrorKind.PermissionDenied,
      'forgejo_permission_denied',
      'Forgejo denied the requested issue operation',
    );
  }
  if (response.status === 409 || response.status === 412 || response.status === 422) {
    return providerError(
      TicketProviderErrorKind.Conflict,
      'forgejo_issue_conflict',
      'Forgejo rejected a conflicting issue update',
    );
  }
  return providerError(
    TicketProviderErrorKind.Unavailable,
    'forgejo_unavailable',
    `Forgejo request failed with status ${response.status}`,
    retryAfter,
  );
}

function stringsFromObjects(value: unknown, key: string): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    isRecord(item) && typeof item[key] === 'string' ? [item[key]] : [],
  );
}

function forgejoIssue(
  value: unknown,
  instanceUrl: string,
  owner: string,
  repository: string,
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
    return providerError(
      TicketProviderErrorKind.InvalidResponse,
      'forgejo_invalid_issue',
      'Forgejo returned a malformed issue',
    );
  }
  const milestone =
    isRecord(value.milestone) && typeof value.milestone.title === 'string'
      ? value.milestone.title
      : undefined;
  const normalized = normalizeProviderDescription(value.body ?? '');
  return ok({
    binding: {
      kind: 'forgejo',
      instanceUrl,
      owner,
      repository,
      issueNumber: value.number,
      externalUrl: value.html_url,
      lastSyncedRevision: value.updated_at,
    },
    title: value.title,
    description: normalized.description,
    ...(normalized.marker === undefined ? {} : { marker: normalized.marker }),
    status: value.state === 'closed' ? 'done' : 'backlog',
    labels: stringsFromObjects(value.labels, 'name'),
    assignees: stringsFromObjects(value.assignees, 'login'),
    ...(milestone === undefined ? {} : { milestone }),
    revision: value.updated_at,
    updatedAt: value.updated_at,
  });
}

function namedResources(
  value: unknown,
  resource: string,
  nameKey: 'name' | 'title',
): Result<readonly NamedResource[], TicketProviderError> {
  if (!Array.isArray(value)) {
    return providerError(
      TicketProviderErrorKind.InvalidResponse,
      `forgejo_invalid_${resource}_list`,
      `Forgejo returned a malformed ${resource} list`,
    );
  }
  const resources: NamedResource[] = [];
  for (const item of value) {
    if (!isRecord(item) || typeof item.id !== 'number' || typeof item[nameKey] !== 'string') {
      return providerError(
        TicketProviderErrorKind.InvalidResponse,
        `forgejo_invalid_${resource}`,
        `Forgejo returned a malformed ${resource}`,
      );
    }
    resources.push({ id: item.id, name: item[nameKey] });
  }
  return ok(resources);
}

function idsForNames(
  resources: readonly NamedResource[],
  names: readonly string[],
  resource: string,
): Result<readonly number[], TicketProviderError> {
  const byName = new Map(resources.map(({ id, name }) => [name, id]));
  const ids: number[] = [];
  for (const name of names) {
    const id = byName.get(name);
    if (id === undefined) {
      return providerError(
        TicketProviderErrorKind.Conflict,
        `forgejo_${resource}_not_found`,
        `Forgejo ${resource} '${name}' does not exist in the configured repository`,
      );
    }
    ids.push(id);
  }
  return ok(ids);
}

function hasPath(paths: Readonly<Record<string, unknown>>, expected: string): boolean {
  return Object.keys(paths).some((path) => path === expected);
}

function capabilitiesFromOpenApi(value: unknown): TicketProviderCapabilities | undefined {
  if (!isRecord(value) || !isRecord(value.paths)) return undefined;
  const paths = value.paths;
  return {
    issues: hasPath(paths, '/repos/{owner}/{repo}/issues'),
    comments: hasPath(paths, '/repos/{owner}/{repo}/issues/{index}/comments'),
    labels: hasPath(paths, '/repos/{owner}/{repo}/labels'),
    assignees: hasPath(paths, '/repos/{owner}/{repo}/assignees'),
    milestones: hasPath(paths, '/repos/{owner}/{repo}/milestones'),
    webhooks: hasPath(paths, '/repos/{owner}/{repo}/hooks'),
    projects: hasPath(paths, '/repos/{owner}/{repo}/projects'),
  };
}

function applyCapabilityOverrides(
  detected: TicketProviderCapabilities,
  overrides: Partial<TicketProviderCapabilities> | undefined,
): TicketProviderCapabilities {
  return { ...detected, ...overrides };
}

export class ForgejoTicketProvider implements TicketProvider {
  readonly kind = 'forgejo' as const;

  private readonly instanceUrl: string;
  private readonly requestFetch: TicketFetch;

  constructor(private readonly options: ForgejoTicketProviderOptions) {
    this.instanceUrl = normalizeInstanceUrl(options.instanceUrl);
    this.requestFetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  async get(binding: TicketBinding): Promise<Result<ProviderTicket, TicketProviderError>> {
    const checked = this.checkBinding(binding);
    if (checked.isErr()) return checked;
    const forgejoBinding = checked.unwrap();
    const response = await this.request(this.issuePath(forgejoBinding.issueNumber));
    return response.isErr()
      ? response
      : forgejoIssue(
          response.unwrap().body,
          this.instanceUrl,
          this.options.owner,
          this.options.repository,
        );
  }

  async list(
    projectId: ProjectId,
  ): Promise<Result<readonly ProviderTicket[], TicketProviderError>> {
    const project = this.checkProject(projectId);
    if (project.isErr()) return project;
    const tickets: ProviderTicket[] = [];
    let received = 0;
    for (let page = 1; ; page += 1) {
      const response = await this.request(
        `${this.repositoryPath()}/issues?state=all&type=issues&limit=50&page=${page}`,
      );
      if (response.isErr()) return response;
      const body = response.unwrap().body;
      if (!Array.isArray(body)) {
        return providerError(
          TicketProviderErrorKind.InvalidResponse,
          'forgejo_invalid_issue_list',
          'Forgejo returned a malformed issue list',
        );
      }
      received += body.length;
      for (const issue of body) {
        if (isRecord(issue) && 'pull_request' in issue) continue;
        const normalized = forgejoIssue(
          issue,
          this.instanceUrl,
          this.options.owner,
          this.options.repository,
        );
        if (normalized.isErr()) return normalized;
        tickets.push(normalized.unwrap());
      }
      const totalHeader = response.unwrap().headers.get('x-total-count');
      const total = totalHeader === null ? undefined : Number(totalHeader);
      const link = response.unwrap().headers.get('link');
      const hasNextLink = link?.includes('rel="next"') ?? false;
      if (
        !hasNextLink &&
        ((total !== undefined && !Number.isNaN(total) && received >= total) ||
          ((total === undefined || Number.isNaN(total)) && body.length < 50))
      ) {
        return ok(tickets);
      }
    }
  }

  async create(
    projectId: ProjectId,
    input: ProviderCreateTicketInput,
  ): Promise<Result<ProviderTicket, TicketProviderError>> {
    const project = this.checkProject(projectId);
    if (project.isErr()) return project;
    const labels = await this.resolveLabels(input.labels ?? []);
    if (labels.isErr()) return labels;
    const milestone = await this.resolveMilestone(input.milestone);
    if (milestone.isErr()) return milestone;
    const description = input.marker
      ? `${input.description}\n\n<!-- ${input.marker} -->`
      : input.description;
    const response = await this.request(`${this.repositoryPath()}/issues`, {
      method: 'POST',
      body: JSON.stringify({
        title: input.title,
        body: description,
        labels: labels.unwrap(),
        assignees: input.assignees ?? [],
        ...(milestone.value === undefined ? {} : { milestone: milestone.value }),
      }),
    });
    return response.isErr()
      ? response
      : forgejoIssue(
          response.unwrap().body,
          this.instanceUrl,
          this.options.owner,
          this.options.repository,
        );
  }

  async update(
    binding: TicketBinding,
    input: ProviderUpdateTicketInput,
  ): Promise<Result<ProviderTicket, TicketProviderError>> {
    const checked = this.checkBinding(binding);
    if (checked.isErr()) return checked;
    const forgejoBinding = checked.unwrap();
    const revision = await this.checkRevision(forgejoBinding, input.expectedRevision);
    if (revision.isErr()) return revision;
    const labels =
      input.labels === undefined
        ? ok<readonly number[]>([])
        : await this.resolveLabels(input.labels);
    if (labels.isErr()) return labels;
    const milestone = await this.resolveMilestone(input.milestone);
    if (milestone.isErr()) return milestone;
    const response = await this.request(this.issuePath(forgejoBinding.issueNumber), {
      method: 'PATCH',
      body: JSON.stringify({
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.description === undefined ? {} : { body: input.description }),
        ...(input.labels === undefined ? {} : { labels: labels.unwrap() }),
        ...(input.assignees === undefined ? {} : { assignees: input.assignees }),
        ...(input.milestone === undefined ? {} : { milestone: milestone.value ?? 0 }),
      }),
    });
    return response.isErr()
      ? response
      : forgejoIssue(
          response.unwrap().body,
          this.instanceUrl,
          this.options.owner,
          this.options.repository,
        );
  }

  async addComment(
    binding: TicketBinding,
    input: AddTicketCommentInput,
  ): Promise<Result<ProviderComment, TicketProviderError>> {
    const checked = this.checkBinding(binding);
    if (checked.isErr()) return checked;
    const forgejoBinding = checked.unwrap();
    const response = await this.request(`${this.issuePath(forgejoBinding.issueNumber)}/comments`, {
      method: 'POST',
      body: JSON.stringify({ body: input.body }),
    });
    if (response.isErr()) return response;
    const value = response.unwrap().body;
    if (
      !isRecord(value) ||
      (typeof value.id !== 'number' && typeof value.id !== 'string') ||
      typeof value.body !== 'string' ||
      typeof value.created_at !== 'string'
    ) {
      return providerError(
        TicketProviderErrorKind.InvalidResponse,
        'forgejo_invalid_comment',
        'Forgejo returned a malformed issue comment',
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

  async detectCapabilities(): Promise<Result<TicketProviderCapabilities, TicketProviderError>> {
    const metadata = await this.detectInstance();
    return metadata.isErr() ? metadata : ok(metadata.unwrap().capabilities);
  }

  async detectInstance(): Promise<Result<ForgejoInstanceMetadata, TicketProviderError>> {
    const versionResponse = await this.request('/version');
    if (versionResponse.isErr()) return versionResponse;
    const versionBody = versionResponse.unwrap().body;
    if (!isRecord(versionBody) || typeof versionBody.version !== 'string') {
      return providerError(
        TicketProviderErrorKind.InvalidResponse,
        'forgejo_invalid_version',
        'Forgejo returned a malformed version response',
      );
    }
    const openApi = await this.requestAbsolute(`${this.instanceUrl}/swagger.v1.json`);
    const advertised = openApi.isOk() ? capabilitiesFromOpenApi(openApi.unwrap().body) : undefined;
    const metadata: ForgejoInstanceMetadata = {
      instanceUrl: this.instanceUrl,
      version: versionBody.version,
      apiVersion: 'v1',
      capabilities: applyCapabilityOverrides(
        advertised ?? unavailableCapabilities,
        this.options.capabilityOverrides,
      ),
      lastCheckedAt: this.options.now?.() ?? new Date().toISOString(),
    };
    const saved = this.options.metadataStore?.saveForgejoMetadata(metadata);
    if (saved?.isErr()) {
      return providerError(
        TicketProviderErrorKind.Unavailable,
        'forgejo_metadata_persistence_failed',
        'Forgejo instance metadata could not be persisted',
      );
    }
    return ok(metadata);
  }

  private async changeState(
    binding: TicketBinding,
    state: 'open' | 'closed',
  ): Promise<Result<void, TicketProviderError>> {
    const checked = this.checkBinding(binding);
    if (checked.isErr()) return checked;
    const forgejoBinding = checked.unwrap();
    const revision = await this.checkRevision(forgejoBinding, forgejoBinding.lastSyncedRevision);
    if (revision.isErr()) return revision;
    const response = await this.request(this.issuePath(forgejoBinding.issueNumber), {
      method: 'PATCH',
      body: JSON.stringify({ state }),
    });
    return response.isErr() ? response : ok(undefined);
  }

  private checkProject(projectId: ProjectId): Result<void, TicketProviderError> {
    return projectId === this.options.projectId
      ? ok(undefined)
      : providerError(
          TicketProviderErrorKind.Conflict,
          'forgejo_project_mismatch',
          'Project does not belong to this Forgejo connection',
        );
  }

  private checkBinding(
    binding: TicketBinding,
  ): Result<Extract<TicketBinding, { readonly kind: 'forgejo' }>, TicketProviderError> {
    if (
      binding.kind !== 'forgejo' ||
      normalizeInstanceUrl(binding.instanceUrl) !== this.instanceUrl ||
      binding.owner !== this.options.owner ||
      binding.repository !== this.options.repository
    ) {
      return providerError(
        TicketProviderErrorKind.Conflict,
        'forgejo_binding_mismatch',
        'Ticket binding does not belong to this Forgejo connection',
      );
    }
    return ok(binding);
  }

  private async checkRevision(
    binding: Extract<TicketBinding, { readonly kind: 'forgejo' }>,
    expectedRevision: string | undefined,
  ): Promise<Result<void, TicketProviderError>> {
    if (expectedRevision === undefined) return ok(undefined);
    const current = await this.get(binding);
    if (current.isErr()) return current;
    return current.unwrap().revision === expectedRevision
      ? ok(undefined)
      : providerError(
          TicketProviderErrorKind.Conflict,
          'forgejo_revision_conflict',
          'Forgejo issue changed after the expected revision',
        );
  }

  private async resolveLabels(
    names: readonly string[],
  ): Promise<Result<readonly number[], TicketProviderError>> {
    if (names.length === 0) return ok([]);
    const response = await this.request(`${this.repositoryPath()}/labels?limit=100`);
    if (response.isErr()) return response;
    const resources = namedResources(response.unwrap().body, 'label', 'name');
    return resources.isErr() ? resources : idsForNames(resources.unwrap(), names, 'label');
  }

  private async resolveMilestone(
    name: string | null | undefined,
  ): Promise<Result<number | undefined, TicketProviderError>> {
    if (name === undefined || name === null) return ok(undefined);
    const response = await this.request(
      `${this.repositoryPath()}/milestones?state=all&type=all&limit=100`,
    );
    if (response.isErr()) return response;
    const resources = namedResources(response.unwrap().body, 'milestone', 'title');
    if (resources.isErr()) return resources;
    const ids = idsForNames(resources.unwrap(), [name], 'milestone');
    return ids.isErr() ? ids : ok(ids.unwrap()[0]);
  }

  private repositoryPath(): string {
    return `/repos/${encodeURIComponent(this.options.owner)}/${encodeURIComponent(this.options.repository)}`;
  }

  private issuePath(issueNumber: number): string {
    return `${this.repositoryPath()}/issues/${issueNumber}`;
  }

  private request(
    path: string,
    init: RequestInit = {},
  ): Promise<Result<ForgejoResponse, TicketProviderError>> {
    return this.requestAbsolute(`${this.instanceUrl}/api/v1${path}`, init);
  }

  private async requestAbsolute(
    url: string,
    init: RequestInit = {},
  ): Promise<Result<ForgejoResponse, TicketProviderError>> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    headers.set('authorization', `token ${this.options.token}`);
    headers.set('content-type', 'application/json');
    headers.set('user-agent', 'kairo-ticket-provider');
    const response = await fromAsync(
      () => this.requestFetch(url, { ...init, headers }),
      () =>
        ({
          kind: TicketProviderErrorKind.Unavailable,
          code: 'forgejo_unavailable',
          message: 'Forgejo could not be reached',
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
          code: 'forgejo_response_read_failed',
          message: 'Forgejo response could not be read',
        }) satisfies TicketProviderError,
    );
    if (text.isErr()) return text;
    const parsed = safeCall(
      (): unknown => JSON.parse(text.unwrap()),
      () =>
        ({
          kind: TicketProviderErrorKind.InvalidResponse,
          code: 'forgejo_invalid_json',
          message: 'Forgejo returned invalid JSON',
        }) satisfies TicketProviderError,
    );
    return parsed.isErr()
      ? parsed
      : ok({ body: parsed.unwrap(), headers: response.unwrap().headers });
  }
}
