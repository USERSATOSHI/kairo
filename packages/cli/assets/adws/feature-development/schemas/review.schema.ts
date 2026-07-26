export default {
  type: 'object',
  additionalProperties: false,
  required: ['approved', 'findings'],
  properties: {
    approved: { type: 'boolean' },
    findings: { type: 'array', items: { type: 'string' } },
  },
} as const;
