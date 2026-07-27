import type { TicketProviderConfigurationView } from '@kouro/api-contracts';
import { ForgejoTicketProvider } from '@kouro/ticket-provider-forgejo';
import { GitHubTicketProvider } from '@kouro/ticket-provider-github';
import type { ForgejoMetadataStore, TicketProvider as RemoteTicketProvider } from '@kouro/tickets';

export interface TicketProviderComposition {
  readonly providers: ReadonlyMap<'github' | 'forgejo', RemoteTicketProvider>;
  readonly configurations: readonly TicketProviderConfigurationView[];
}

function configured(values: readonly (string | undefined)[]): boolean {
  return values.every((value) => Boolean(value?.trim()));
}

function environmentValue(
  environment: Readonly<Record<string, string | undefined>>,
  name: string,
): string | undefined {
  return environment[name]?.trim() ?? environment[name.replace(/^KOURO_/, 'KAIRO_')]?.trim();
}

/**
 * Composes remote ticket adapters exclusively from process environment values.
 * Tokens remain constructor inputs and are never included in returned views.
 */
export function composeTicketProviders(
  environment: Readonly<Record<string, string | undefined>>,
  forgejoMetadata: ForgejoMetadataStore,
): TicketProviderComposition {
  const providers = new Map<'github' | 'forgejo', RemoteTicketProvider>();
  const githubOwner = environmentValue(environment, 'KOURO_GITHUB_OWNER');
  const githubRepository = environmentValue(environment, 'KOURO_GITHUB_REPOSITORY');
  const githubProject = environmentValue(environment, 'KOURO_GITHUB_PROJECT');
  const githubToken = environmentValue(environment, 'KOURO_GITHUB_TOKEN');
  const githubApiUrl = environmentValue(environment, 'KOURO_GITHUB_API_URL');
  const hasGitHub = configured([githubOwner, githubRepository, githubProject, githubToken]);
  if (hasGitHub && githubOwner && githubRepository && githubProject && githubToken) {
    providers.set(
      'github',
      new GitHubTicketProvider({
        owner: githubOwner,
        repository: githubRepository,
        projectId: githubProject,
        token: githubToken,
        ...(githubApiUrl ? { apiUrl: githubApiUrl } : {}),
      }),
    );
  }

  const forgejoInstanceUrl = environmentValue(environment, 'KOURO_FORGEJO_URL');
  const forgejoOwner = environmentValue(environment, 'KOURO_FORGEJO_OWNER');
  const forgejoRepository = environmentValue(environment, 'KOURO_FORGEJO_REPOSITORY');
  const forgejoProject = environmentValue(environment, 'KOURO_FORGEJO_PROJECT');
  const forgejoToken = environmentValue(environment, 'KOURO_FORGEJO_TOKEN');
  const hasForgejo = configured([
    forgejoInstanceUrl,
    forgejoOwner,
    forgejoRepository,
    forgejoProject,
    forgejoToken,
  ]);
  if (
    hasForgejo &&
    forgejoInstanceUrl &&
    forgejoOwner &&
    forgejoRepository &&
    forgejoProject &&
    forgejoToken
  ) {
    providers.set(
      'forgejo',
      new ForgejoTicketProvider({
        instanceUrl: forgejoInstanceUrl,
        owner: forgejoOwner,
        repository: forgejoRepository,
        projectId: forgejoProject,
        token: forgejoToken,
        metadataStore: forgejoMetadata,
      }),
    );
  }

  return {
    providers,
    configurations: [
      {
        id: 'local',
        displayName: 'Local SQLite',
        configured: true,
        credentialSource: 'none',
        message: 'Available without a remote account or repository.',
      },
      {
        id: 'github',
        displayName: 'GitHub Issues',
        configured: hasGitHub,
        credentialSource: 'server_environment',
        ...(githubApiUrl ? { endpoint: githubApiUrl } : {}),
        ...(githubOwner ? { owner: githubOwner } : {}),
        ...(githubRepository ? { repository: githubRepository } : {}),
        message: hasGitHub
          ? 'Configured from the KOURO_GITHUB_* environment variables.'
          : 'Set KOURO_GITHUB_OWNER, REPOSITORY, PROJECT, and TOKEN.',
      },
      {
        id: 'forgejo',
        displayName: 'Forgejo Issues',
        configured: hasForgejo,
        credentialSource: 'server_environment',
        ...(forgejoInstanceUrl ? { endpoint: forgejoInstanceUrl } : {}),
        ...(forgejoOwner ? { owner: forgejoOwner } : {}),
        ...(forgejoRepository ? { repository: forgejoRepository } : {}),
        message: hasForgejo
          ? 'Configured from the KOURO_FORGEJO_* environment variables.'
          : 'Set KOURO_FORGEJO_URL, OWNER, REPOSITORY, PROJECT, and TOKEN.',
      },
    ],
  };
}
