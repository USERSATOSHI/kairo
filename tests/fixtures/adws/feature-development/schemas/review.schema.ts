export default {
  type: 'object',
  additionalProperties: false,
  required: ['approved', 'summary'],
  properties: {
    approved: { type: 'boolean' },
    summary: { type: 'string' },
  },
} as const;
