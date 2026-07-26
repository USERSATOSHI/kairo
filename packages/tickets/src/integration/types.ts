import type {
  ProjectId,
  RunId,
  Ticket,
  TicketBinding,
  TicketId,
  TicketPriority,
} from '../domain/types.ts';

export type TicketRunLinkKind = 'planning' | 'implementation' | 'review' | 'remediation';

export interface TicketRunLink {
  readonly ticketId: TicketId;
  readonly runId: RunId;
  readonly kind: TicketRunLinkKind;
  readonly createdAt: string;
}

export interface TicketSnapshot {
  readonly id: string;
  readonly runId: RunId;
  readonly ticketId: TicketId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly description: string;
  readonly priority?: TicketPriority;
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
  readonly provider: 'local' | 'github' | 'forgejo';
  readonly providerRevision: string;
  readonly capturedAt: string;
}

export type ActiveRunTicketChangePolicy =
  | 'ignore_until_next_run'
  | 'notify_only'
  | 'pause_for_review'
  | 'cancel_and_replan';

export type TicketChangeKind =
  | 'title'
  | 'description'
  | 'acceptance_criteria'
  | 'labels'
  | 'assignees'
  | 'comment'
  | 'external_close';

export interface TicketChangeDecision {
  readonly policy: ActiveRunTicketChangePolicy;
  readonly command: 'none' | 'notify' | 'pause' | 'cancel';
}

export type TicketBoardColumn =
  | 'backlog'
  | 'ready'
  | 'planning'
  | 'waiting_for_plan_approval'
  | 'implementing'
  | 'validating'
  | 'repairing'
  | 'reviewing'
  | 'waiting_for_delivery_approval'
  | 'blocked'
  | 'failed'
  | 'done'
  | 'cancelled';

export interface TicketRunView {
  readonly runId: RunId;
  readonly active: boolean;
  readonly column: Exclude<TicketBoardColumn, 'backlog' | 'ready'>;
}

export interface TicketBoardCard {
  readonly ticket: Ticket;
  readonly column: TicketBoardColumn;
  readonly activeRun?: TicketRunView;
}

export interface TicketSyncState {
  readonly ticketId: TicketId;
  readonly provider: TicketBinding['kind'];
  readonly status: 'idle' | 'pending' | 'succeeded' | 'failed';
  readonly lastSyncedAt?: string;
  readonly lastError?: string;
  readonly nextRetryAt?: string;
}

export interface ExternalTicketEvent {
  readonly provider: 'github' | 'forgejo';
  readonly providerEventId: string;
  readonly eventType: string;
  readonly payload: string;
  readonly receivedAt: string;
}

export interface ForgejoInstanceMetadata {
  readonly instanceUrl: string;
  readonly version: string;
  readonly apiVersion?: string;
  readonly capabilities: import('../provider/types.ts').TicketProviderCapabilities;
  readonly lastCheckedAt: string;
}
