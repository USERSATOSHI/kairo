export default {
  type: 'object',
  additionalProperties: false,
  required: ['summary', 'changedFiles'],
  properties: {
    summary: { type: 'string' },
    changedFiles: { type: 'array', items: { type: 'string' } },
  },
} as const;
