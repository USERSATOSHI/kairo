export default {
  type: 'object',
  additionalProperties: false,
  required: [
    'targetType',
    'target',
    'scope',
    'riskLevel',
    'recommendedTools',
    'knownAttackSurface',
  ],
  properties: {
    targetType: {
      type: 'string',
      enum: ['repository', 'url'],
    },
    target: { type: 'string', minLength: 1 },
    scope: { type: 'string', minLength: 1 },
    riskLevel: {
      type: 'string',
      enum: ['low', 'medium', 'high'],
    },
    recommendedTools: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
    },
    knownAttackSurface: {
      type: 'array',
      items: { type: 'string', minLength: 1 },
    },
    scanRateLimit: {
      type: 'object',
      additionalProperties: false,
      required: ['delayBetweenRequestsMs', 'maxConcurrentRequests', 'maxUrlsToScan'],
      properties: {
        delayBetweenRequestsMs: {
          type: 'number',
          minimum: 1000,
          description: 'Minimum delay in milliseconds between requests. Must be >= 1000.',
        },
        maxConcurrentRequests: {
          type: 'number',
          minimum: 1,
          maximum: 3,
          description: 'Maximum concurrent requests. Keep low to avoid overloading.',
        },
        maxUrlsToScan: {
          type: 'number',
          minimum: 1,
          description: 'Maximum number of distinct URLs/pages to scan.',
        },
      },
    },
    notes: { type: 'string' },
  },
} as const;
