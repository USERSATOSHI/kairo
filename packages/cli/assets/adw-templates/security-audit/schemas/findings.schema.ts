export default {
  type: 'object',
  additionalProperties: false,
  required: ['executiveSummary', 'auditScope', 'findings', 'riskSummary', 'recommendations'],
  properties: {
    executiveSummary: {
      type: 'string',
      minLength: 1,
      description: 'High-level overview of the audit and key findings.',
    },
    auditScope: {
      type: 'string',
      minLength: 1,
      description: 'What was audited, excluded, and methodology used.',
    },
    findings: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'title',
          'severity',
          'description',
          'location',
          'exploitationSteps',
          'impact',
          'remediation',
        ],
        properties: {
          title: { type: 'string', minLength: 1 },
          severity: {
            type: 'string',
            enum: ['critical', 'high', 'medium', 'low', 'informational'],
          },
          description: { type: 'string', minLength: 1 },
          location: {
            type: 'string',
            minLength: 1,
            description: 'Exact file path (for repos) or URL/endpoint (for URLs)',
          },
          exploitationSteps: {
            type: 'string',
            minLength: 1,
            description: 'Step-by-step instructions on how to exploit this vulnerability.',
          },
          impact: { type: 'string', minLength: 1 },
          remediation: { type: 'string', minLength: 1 },
          evidence: { type: 'string' },
        },
      },
    },
    riskSummary: {
      type: 'string',
      minLength: 1,
      description: 'Aggregated risk view by category and severity.',
    },
    recommendations: {
      type: 'array',
      minItems: 1,
      items: { type: 'string', minLength: 1 },
    },
    appendix: {
      type: 'string',
      description: 'Tools used, scan parameters, and technical details.',
    },
  },
} as const;
