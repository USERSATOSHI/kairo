function parseJson(value: string): { readonly parsed: boolean; readonly value?: unknown } {
  try {
    return { parsed: true, value: JSON.parse(value) as unknown };
  } catch {
    return { parsed: false };
  }
}

/**
 * Extracts one explicit JSON response from a harness message while preserving
 * ordinary conversational text when no unambiguous JSON response is present.
 */
export function parseHarnessOutput(value: string): unknown {
  const parsed = parseJson(value);
  if (parsed.parsed) return parsed.value;

  const candidates = [...value.matchAll(/```json\s*([\s\S]*?)```/gi)]
    .map((match) => parseJson(match[1] ?? ''))
    .filter((candidate) => candidate.parsed);
  return candidates.length === 1 ? candidates[0]?.value : value;
}
