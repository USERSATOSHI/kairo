import {
  DeliveryErrorKind,
  type CreatePullRequestInput,
  type DeliveryError,
  type PullRequestDetails,
  type PullRequestProvider,
  type PullRequestTarget,
} from '@kouro/delivery';
import { err, fromAsync, ok, type Result } from '@usersatoshi/results';

export interface GitHubPullRequestProviderOptions {
  readonly token: string;
  readonly apiUrl?: string;
  readonly fetch?: DeliveryFetch;
}

export interface DeliveryFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function failure(response: Response): Result<never, DeliveryError> {
  const kind =
    response.status === 401
      ? DeliveryErrorKind.Authentication
      : response.status === 404
        ? DeliveryErrorKind.NotFound
        : [409, 422].includes(response.status)
          ? DeliveryErrorKind.Conflict
          : DeliveryErrorKind.Unavailable;
  return err({
    kind,
    code: `github_http_${response.status}`,
    message: `GitHub pull-request request failed with status ${response.status}`,
  });
}

function parse(
  value: unknown,
  input: PullRequestTarget,
): Result<PullRequestDetails, DeliveryError> {
  if (
    !isRecord(value) ||
    typeof value.number !== 'number' ||
    typeof value.html_url !== 'string' ||
    typeof value.title !== 'string'
  ) {
    return err({
      kind: DeliveryErrorKind.InvalidResponse,
      code: 'github_invalid_pull_request',
      message: 'GitHub returned a malformed pull request',
    });
  }
  return ok({
    ...input,
    number: value.number,
    url: value.html_url,
    title: value.title,
    draft: value.draft === true,
  });
}

export class GitHubPullRequestProvider implements PullRequestProvider {
  readonly id = 'github' as const;
  private readonly apiUrl: string;
  private readonly requestFetch: DeliveryFetch;

  constructor(private readonly options: GitHubPullRequestProviderOptions) {
    this.apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');
    this.requestFetch = options.fetch ?? fetch;
  }

  async find(
    input: PullRequestTarget,
  ): Promise<Result<PullRequestDetails | undefined, DeliveryError>> {
    const query = new URLSearchParams({
      state: 'all',
      head: `${input.owner}:${input.head}`,
      base: input.base,
    });
    const response = await this.request(
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls?${query}`,
    );
    if (response.isErr()) return response;
    if (!Array.isArray(response.value)) {
      return err({
        kind: DeliveryErrorKind.InvalidResponse,
        code: 'github_invalid_pull_request_list',
        message: 'GitHub returned a malformed pull-request list',
      });
    }
    const first = response.value[0];
    return first === undefined ? ok(undefined) : parse(first, input);
  }

  async create(input: CreatePullRequestInput): Promise<Result<PullRequestDetails, DeliveryError>> {
    const response = await this.request(
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repository)}/pulls`,
      {
        method: 'POST',
        body: JSON.stringify({
          title: input.title,
          head: input.head,
          base: input.base,
          body: input.body ?? '',
          draft: input.draft,
        }),
      },
    );
    return response.isErr() ? response : parse(response.value, input);
  }

  private async request(
    path: string,
    init: RequestInit = {},
  ): Promise<Result<unknown, DeliveryError>> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/vnd.github+json');
    headers.set('authorization', `Bearer ${this.options.token}`);
    headers.set('content-type', 'application/json');
    const fetched = await fromAsync(
      () =>
        this.requestFetch(`${this.apiUrl}${path}`, {
          ...init,
          headers,
        }),
      () => ({
        kind: DeliveryErrorKind.Unavailable,
        code: 'github_unavailable',
        message: 'GitHub could not be reached',
      }),
    );
    if (fetched.isErr()) return fetched;
    const response = fetched.value;
    if (!response.ok) return failure(response);
    return fromAsync(
      () => response.json() as Promise<unknown>,
      () => ({
        kind: DeliveryErrorKind.InvalidResponse,
        code: 'github_invalid_json',
        message: 'GitHub returned invalid JSON',
      }),
    );
  }
}
