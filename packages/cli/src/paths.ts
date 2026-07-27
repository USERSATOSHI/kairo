import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';

export interface LocalPaths {
  readonly dataDirectory: string;
  readonly configDirectory: string;
  readonly databasePath: string;
  readonly artifactDirectory: string;
  readonly worktreeDirectory: string;
}

function defaultDirectory(
  base: string,
  currentName: string,
  legacyName: string,
): { readonly path: string; readonly legacy: boolean } {
  const current = resolve(base, currentName);
  const legacy = resolve(base, legacyName);
  return !existsSync(current) && existsSync(legacy)
    ? { path: legacy, legacy: true }
    : { path: current, legacy: false };
}

/** Resolves stable XDG-compatible local paths with explicit Kouro overrides. */
export function resolveLocalPaths(environment: NodeJS.ProcessEnv = process.env): LocalPaths {
  const defaultData = defaultDirectory(
    environment.XDG_DATA_HOME ?? resolve(homedir(), '.local', 'share'),
    'kouro',
    'kairo',
  );
  const defaultConfig = defaultDirectory(
    environment.XDG_CONFIG_HOME ?? resolve(homedir(), '.config'),
    'kouro',
    'kairo',
  );
  const legacyDataOverride =
    environment.KOURO_DATA_DIR === undefined && environment.KAIRO_DATA_DIR !== undefined;
  const dataDirectory = resolve(
    environment.KOURO_DATA_DIR ?? environment.KAIRO_DATA_DIR ?? defaultData.path,
  );
  const configDirectory = resolve(
    environment.KOURO_CONFIG_DIR ?? environment.KAIRO_CONFIG_DIR ?? defaultConfig.path,
  );
  const legacyDatabase = legacyDataOverride || (!environment.KOURO_DATA_DIR && defaultData.legacy);
  return {
    dataDirectory,
    configDirectory,
    databasePath: resolve(dataDirectory, legacyDatabase ? 'kairo.sqlite' : 'kouro.sqlite'),
    artifactDirectory: resolve(dataDirectory, 'artifacts'),
    worktreeDirectory: resolve(dataDirectory, 'worktrees'),
  };
}
