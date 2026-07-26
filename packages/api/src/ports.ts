import type {
  ArtifactContent,
  CreateRunRequest,
  CreateRunResponse,
  RepositorySummary,
  TicketProviderConfigurationView,
  TicketProjectView,
} from '@kairo/api-contracts';
import type { ArtifactReference } from '@kairo/domain';
import type { RunAggregate, RunStoreError } from '@kairo/executors';
import type { Result } from '@usersatoshi/results';
import type {
  TicketHistoryStore,
  TicketRepository,
  TicketRunQuery,
  TicketRunStore,
  TicketSyncStore,
} from '@kairo/tickets';

export interface ObservableRunStore {
  loadRun(runId: string): Result<RunAggregate, RunStoreError>;
  listRuns(): Result<readonly RunAggregate[], RunStoreError>;
}

export interface ArtifactContentReader {
  read(
    runId: string,
    artifact: ArtifactReference,
    invocationSequence?: number,
    attemptNumber?: number,
  ): Promise<Result<ArtifactContent, ArtifactContentReaderError>>;
}

export interface ArtifactContentReaderError {
  readonly kind: 0;
  readonly message: string;
}

export interface RepositoryQuery {
  list(): Promise<readonly RepositorySummary[]>;
}

export interface LocalRunCreator {
  create(request: CreateRunRequest): Promise<Result<CreateRunResponse, LocalRunCreatorError>>;
}

export interface LocalRunCreatorError {
  readonly kind: number;
  readonly message: string;
}

export interface TicketReadServices {
  readonly repository: Pick<
    TicketRepository,
    'get' | 'list' | 'listComments' | 'listRelationships'
  > & {
    listProjects(): Result<readonly TicketProjectView[], import('@kairo/tickets').TicketError>;
  };
  readonly runs: TicketRunStore;
  readonly runQuery: TicketRunQuery;
  readonly sync: TicketSyncStore & TicketHistoryStore;
}

export interface TicketProviderConfigurationQuery {
  list(): readonly TicketProviderConfigurationView[];
}
