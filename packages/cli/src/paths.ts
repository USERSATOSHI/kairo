import { homedir } from 'node:os';
import { resolve } from 'node:path';

export interface LocalPaths {
  readonly dataDirectory: string;
  readonly configDirectory: string;
  readonly databasePath: string;
  readonly artifactDirectory: string;
  readonly worktreeDirectory: string;
}

/** Resolves stable XDG-compatible local paths with explicit Kairo overrides. */
export function resolveLocalPaths(environment: NodeJS.ProcessEnv = process.env): LocalPaths {
  const dataDirectory = resolve(
    environment.KAIRO_DATA_DIR ??
      resolve(environment.XDG_DATA_HOME ?? resolve(homedir(), '.local', 'share'), 'kairo'),
  );
  const configDirectory = resolve(
    environment.KAIRO_CONFIG_DIR ??
      resolve(environment.XDG_CONFIG_HOME ?? resolve(homedir(), '.config'), 'kairo'),
  );
  return {
    dataDirectory,
    configDirectory,
    databasePath: resolve(dataDirectory, 'kairo.sqlite'),
    artifactDirectory: resolve(dataDirectory, 'artifacts'),
    worktreeDirectory: resolve(dataDirectory, 'worktrees'),
  };
}
