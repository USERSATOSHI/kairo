export default {
  type: 'object',
  additionalProperties: false,
  required: ['approved', 'findings'],
  properties: {
    approved: { type: 'boolean' },
    findings: { type: 'array', items: { type: 'string' } },
    deliveryMetadata: {
      type: 'object',
      additionalProperties: false,
      required: ['commitTitle', 'pullRequestTitle', 'draft'],
      properties: {
        commitTitle: { type: 'string' },
        commitBody: { type: 'string' },
        pullRequestTitle: { type: 'string' },
        pullRequestBody: { type: 'string' },
        draft: { type: 'boolean' },
      },
    },
  },
} as const;
