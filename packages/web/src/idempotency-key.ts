interface RandomSource {
  readonly randomUUID?: () => string;
  readonly getRandomValues?: (values: Uint8Array) => Uint8Array;
}

function fallbackUuid(source: RandomSource | undefined): string {
  const bytes = new Uint8Array(16);
  if (source?.getRandomValues) {
    source.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Creates an idempotency key even when the page is served over insecure HTTP. */
export function newIdempotencyKey(source: RandomSource | undefined = globalThis.crypto): string {
  return source?.randomUUID ? source.randomUUID() : fallbackUuid(source);
}
