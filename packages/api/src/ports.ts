import type {
  ArtifactContent,
  CreateRunRequest,
  CreateRunResponse,
  RepositorySummary,
} from '@kairo/api-contracts';
import type { ArtifactReference } from '@kairo/domain';
import type { RunAggregate, RunStoreError } from '@kairo/executors';
import type { Result } from '@usersatoshi/results';

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
