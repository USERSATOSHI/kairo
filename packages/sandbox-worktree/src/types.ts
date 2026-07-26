export interface RegisteredRepository {
  readonly repositoryId: string;
  readonly repositoryPath: string;
  readonly commonGitDirectory: string;
}

export interface PinnedRepository extends RegisteredRepository {
  readonly startingCommit: string;
}

export interface RunWorktree {
  readonly repositoryId: string;
  readonly runId: string;
  readonly repositoryPath: string;
  readonly path: string;
  readonly commonGitDirectory: string;
  readonly startingCommit: string;
}

export interface PreparedCommit {
  readonly head: string;
  readonly tree: string;
}

export interface CommitIdentity {
  readonly name: string;
  readonly email: string;
}

export interface CommitWorktreeInput {
  readonly worktree: RunWorktree;
  readonly expectedHead: string;
  readonly expectedTree: string;
  readonly message: string;
  readonly identity: CommitIdentity;
  readonly timestamp: string;
}

export interface CommitResult {
  readonly commit: string;
  readonly recovered: boolean;
}

export type GitArtifactKind = 'status' | 'diff';

export interface GitArtifact {
  readonly kind: GitArtifactKind;
  readonly path: string;
  readonly checksum: string;
  readonly size: number;
}

export interface WorktreeArtifacts {
  readonly status: GitArtifact;
  readonly diff: GitArtifact;
}
