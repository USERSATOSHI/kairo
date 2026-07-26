import type { TicketProviderConfigurationView } from '@kairo/api-contracts';
import { ForgejoTicketProvider } from '@kairo/ticket-provider-forgejo';
import { GitHubTicketProvider } from '@kairo/ticket-provider-github';
import type { ForgejoMetadataStore, TicketProvider as RemoteTicketProvider } from '@kairo/tickets';

export interface TicketProviderComposition {
  readonly providers: ReadonlyMap<'github' | 'forgejo', RemoteTicketProvider>;
  readonly configurations: readonly TicketProviderConfigurationView[];
}

function configured(values: readonly (string | undefined)[]): boolean {
  return values.every((value) => Boolean(value?.trim()));
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
  const githubOwner = environment.KAIRO_GITHUB_OWNER?.trim();
  const githubRepository = environment.KAIRO_GITHUB_REPOSITORY?.trim();
  const githubProject = environment.KAIRO_GITHUB_PROJECT?.trim();
  const githubToken = environment.KAIRO_GITHUB_TOKEN?.trim();
  const githubApiUrl = environment.KAIRO_GITHUB_API_URL?.trim();
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

  const forgejoInstanceUrl = environment.KAIRO_FORGEJO_URL?.trim();
  const forgejoOwner = environment.KAIRO_FORGEJO_OWNER?.trim();
  const forgejoRepository = environment.KAIRO_FORGEJO_REPOSITORY?.trim();
  const forgejoProject = environment.KAIRO_FORGEJO_PROJECT?.trim();
  const forgejoToken = environment.KAIRO_FORGEJO_TOKEN?.trim();
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
          ? 'Configured from the KAIRO_GITHUB_* environment variables.'
          : 'Set KAIRO_GITHUB_OWNER, REPOSITORY, PROJECT, and TOKEN.',
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
          ? 'Configured from the KAIRO_FORGEJO_* environment variables.'
          : 'Set KAIRO_FORGEJO_URL, OWNER, REPOSITORY, PROJECT, and TOKEN.',
      },
    ],
  };
}
