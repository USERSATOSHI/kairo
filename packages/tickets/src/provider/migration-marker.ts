export interface NormalizedProviderDescription {
  readonly description: string;
  readonly marker?: string;
}

/**
 * Removes Kouro's durable migration marker from provider-visible issue text.
 */
export function normalizeProviderDescription(body: string): NormalizedProviderDescription {
  const match = /\n\n<!-- ((?:kouro|kairo)-ticket:[^\n]+) -->$/.exec(body);
  return match?.[1]
    ? {
        description: body.slice(0, match.index),
        marker: match[1],
      }
    : { description: body };
}
