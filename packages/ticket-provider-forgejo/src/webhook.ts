import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  TicketProviderErrorKind,
  type ProviderTicket,
  type TicketProviderError,
} from '@kairo/tickets';
import { ok, safeCall, type Result } from '@usersatoshi/results';

import { forgejoError } from './errors.ts';

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringsFromObjects(value: unknown, key: string): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) =>
    isRecord(item) && typeof item[key] === 'string' ? [item[key]] : [],
  );
}

export function validateForgejoWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
): Result<boolean, TicketProviderError> {
  return safeCall(
    () => {
      const expected = createHmac('sha256', secret).update(payload).digest('hex');
      const actualBytes = Buffer.from(signature);
      const expectedBytes = Buffer.from(expected);
      return (
        actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes)
      );
    },
    () => ({
      kind: TicketProviderErrorKind.InvalidResponse,
      code: 'forgejo_signature_validation_failed',
      message: 'Forgejo webhook signature could not be validated',
    }),
  );
}

export function normalizeForgejoIssueWebhook(
  payload: unknown,
  instanceUrl: string,
  owner: string,
  repository: string,
): Result<ProviderTicket, TicketProviderError> {
  if (!isRecord(payload) || !isRecord(payload.issue)) {
    return forgejoError({
      kind: TicketProviderErrorKind.InvalidResponse,
      code: 'forgejo_invalid_webhook',
      message: 'Forgejo webhook does not contain an issue',
    });
  }
  const issue = payload.issue;
  if (
    typeof issue.number !== 'number' ||
    typeof issue.title !== 'string' ||
    typeof issue.html_url !== 'string' ||
    typeof issue.updated_at !== 'string' ||
    (issue.state !== 'open' && issue.state !== 'closed')
  ) {
    return forgejoError({
      kind: TicketProviderErrorKind.InvalidResponse,
      code: 'forgejo_invalid_webhook_issue',
      message: 'Forgejo webhook issue is malformed',
    });
  }
  const milestone =
    isRecord(issue.milestone) && typeof issue.milestone.title === 'string'
      ? issue.milestone.title
      : undefined;
  return ok({
    binding: {
      kind: 'forgejo',
      instanceUrl: instanceUrl.replace(/\/+$/, ''),
      owner,
      repository,
      issueNumber: issue.number,
      externalUrl: issue.html_url,
      lastSyncedRevision: issue.updated_at,
    },
    title: issue.title,
    description: typeof issue.body === 'string' ? issue.body : '',
    status: issue.state === 'closed' ? 'done' : 'backlog',
    labels: stringsFromObjects(issue.labels, 'name'),
    assignees: stringsFromObjects(issue.assignees, 'login'),
    ...(milestone === undefined ? {} : { milestone }),
    revision: issue.updated_at,
    updatedAt: issue.updated_at,
  });
}
