import { ForgejoPullRequestProvider } from '@kouro/delivery-provider-forgejo';
import { GitHubPullRequestProvider } from '@kouro/delivery-provider-github';

import { pullRequestProviderContract } from '../contracts/pull-request-provider.contract.ts';

const response = {
  number: 17,
  html_url: 'https://forge.example/pulls/17',
  title: 'Reviewed delivery',
  draft: false,
};

pullRequestProviderContract('GitHub', {
  create: (fetch) =>
    new GitHubPullRequestProvider({
      token: 'secret',
      apiUrl: 'https://api.example',
      fetch,
    }),
  existingResponse: response,
});

pullRequestProviderContract('Forgejo', {
  create: (fetch) =>
    new ForgejoPullRequestProvider({
      instanceUrl: 'https://forge.example',
      token: 'secret',
      fetch,
    }),
  existingResponse: response,
});
