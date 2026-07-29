export type TranscriptEntryKind = 'user' | 'agent' | 'reasoning' | 'tool_call' | 'tool_result';

export interface TranscriptEntry {
  readonly id: string;
  readonly kind: TranscriptEntryKind;
  readonly text: string;
  readonly callId?: string;
  readonly toolName?: string;
  readonly status?: string;
}

export interface TranscriptGroup {
  readonly primary: TranscriptEntry;
  readonly results: readonly TranscriptEntry[];
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringAt(value: Readonly<Record<string, unknown>>, ...keys: readonly string[]) {
  for (const key of keys) {
    if (typeof value[key] === 'string') return value[key];
  }
  return undefined;
}

function display(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return 'Value could not be displayed';
  }
}

function normalizedMessage(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function contentText(content: unknown, kind: 'text' | 'reasoning'): string {
  if (!Array.isArray(content)) return '';
  const accepted = kind === 'reasoning' ? new Set(['thinking', 'reasoning']) : new Set(['text']);
  return content
    .filter(isRecord)
    .filter((block) => accepted.has(String(block.type)))
    .map((block) => stringAt(block, 'text', 'thinking') ?? '')
    .filter(Boolean)
    .join('\n');
}

function addToolCall(
  entries: TranscriptEntry[],
  calls: Set<string>,
  id: string,
  callId: string,
  toolName: string,
  input: unknown,
): void {
  if (calls.has(callId)) return;
  calls.add(callId);
  entries.push({
    id,
    kind: 'tool_call',
    callId,
    toolName,
    text: display(input) || 'No input',
  });
}

function parseMessageBlocks(
  message: Readonly<Record<string, unknown>>,
  id: string,
  entries: TranscriptEntry[],
  calls: Set<string>,
): void {
  const role = message.role === 'user' ? 'user' : 'agent';
  const reasoning = contentText(message.content, 'reasoning');
  const text = contentText(message.content, 'text');
  if (reasoning) entries.push({ id: `${id}:reasoning`, kind: 'reasoning', text: reasoning });
  if (text) entries.push({ id: `${id}:text`, kind: role, text });
  if (!Array.isArray(message.content)) return;
  for (const [index, block] of message.content.entries()) {
    if (!isRecord(block) || !['toolCall', 'tool_use'].includes(String(block.type))) continue;
    const callId = stringAt(block, 'id', 'toolCallId', 'tool_use_id') ?? `${id}:tool:${index}`;
    addToolCall(
      entries,
      calls,
      `${id}:tool:${index}`,
      callId,
      stringAt(block, 'name', 'toolName') ?? 'tool',
      block.arguments ?? block.input,
    );
  }
}

function parseCodexItem(
  eventType: string,
  item: Readonly<Record<string, unknown>>,
  id: string,
  entries: TranscriptEntry[],
  calls: Set<string>,
): boolean {
  const itemType = stringAt(item, 'type') ?? '';
  const callId = stringAt(item, 'id', 'call_id') ?? id;
  if (itemType === 'agent_message') {
    const text = stringAt(item, 'text');
    if (text) entries.push({ id, kind: 'agent', text });
    return true;
  }
  if (itemType === 'reasoning') {
    const text = stringAt(item, 'text') ?? display(item.summary);
    if (text) entries.push({ id, kind: 'reasoning', text });
    return true;
  }
  if (itemType === 'command_execution') {
    addToolCall(entries, calls, `${id}:call`, callId, 'shell', item.command);
    if (eventType === 'item.completed') {
      entries.push({
        id: `${id}:result`,
        kind: 'tool_result',
        callId,
        toolName: 'shell',
        status: stringAt(item, 'status') ?? display(item.exit_code),
        text: stringAt(item, 'aggregated_output', 'output') ?? 'No output',
      });
    }
    return true;
  }
  if (itemType === 'mcp_tool_call') {
    const toolName = [stringAt(item, 'server'), stringAt(item, 'tool', 'name')]
      .filter(Boolean)
      .join('.');
    addToolCall(entries, calls, `${id}:call`, callId, toolName || 'MCP tool', item.arguments);
    if (eventType === 'item.completed') {
      entries.push({
        id: `${id}:result`,
        kind: 'tool_result',
        callId,
        toolName: toolName || 'MCP tool',
        status: stringAt(item, 'status'),
        text: display(item.result ?? item.error) || 'No output',
      });
    }
    return true;
  }
  if (itemType === 'web_search') {
    addToolCall(entries, calls, `${id}:call`, callId, 'web search', item.query);
    if (eventType === 'item.completed') {
      entries.push({
        id: `${id}:result`,
        kind: 'tool_result',
        callId,
        toolName: 'web search',
        status: stringAt(item, 'status'),
        text: display(item.result) || 'Search completed',
      });
    }
    return true;
  }
  return false;
}

function parseToolEvent(
  event: Readonly<Record<string, unknown>>,
  id: string,
  entries: TranscriptEntry[],
  calls: Set<string>,
): boolean {
  const eventType = stringAt(event, 'type') ?? '';
  if (eventType === 'tool_execution_start') {
    const callId = stringAt(event, 'toolCallId', 'callID', 'id') ?? id;
    addToolCall(
      entries,
      calls,
      id,
      callId,
      stringAt(event, 'toolName', 'tool') ?? 'tool',
      event.args ?? event.input,
    );
    return true;
  }
  if (eventType === 'tool_execution_end' || eventType === 'tool_result') {
    entries.push({
      id,
      kind: 'tool_result',
      callId: stringAt(event, 'toolCallId', 'callID', 'tool_use_id', 'id') ?? id,
      toolName: stringAt(event, 'toolName', 'tool'),
      status: event.isError === true ? 'failed' : (stringAt(event, 'status') ?? 'completed'),
      text: display(event.result ?? event.output ?? event.content) || 'No output',
    });
    return true;
  }
  return false;
}

function parseOpenCodePart(
  part: Readonly<Record<string, unknown>>,
  id: string,
  entries: TranscriptEntry[],
  calls: Set<string>,
): boolean {
  const partType = stringAt(part, 'type') ?? '';
  if (partType === 'text' && typeof part.text === 'string') {
    entries.push({ id, kind: 'agent', text: part.text });
    return true;
  }
  if (partType === 'reasoning' && typeof part.text === 'string') {
    entries.push({ id, kind: 'reasoning', text: part.text });
    return true;
  }
  if (partType !== 'tool' || !isRecord(part.state)) return false;
  const callId = stringAt(part, 'callID', 'callId', 'id') ?? id;
  const toolName = stringAt(part, 'tool', 'name') ?? 'tool';
  addToolCall(entries, calls, `${id}:call`, callId, toolName, part.state.input);
  if (['completed', 'error'].includes(String(part.state.status))) {
    entries.push({
      id: `${id}:result`,
      kind: 'tool_result',
      callId,
      toolName,
      status: String(part.state.status),
      text: display(part.state.output ?? part.state.error) || 'No output',
    });
  }
  return true;
}

function parseEvent(
  event: Readonly<Record<string, unknown>>,
  id: string,
  entries: TranscriptEntry[],
  calls: Set<string>,
): void {
  const eventType = stringAt(event, 'type') ?? '';
  if (isRecord(event.item) && parseCodexItem(eventType, event.item, id, entries, calls)) return;
  if (parseToolEvent(event, id, entries, calls)) return;
  if (isRecord(event.part) && parseOpenCodePart(event.part, id, entries, calls)) return;
  if (eventType === 'message_end' && isRecord(event.message)) {
    parseMessageBlocks(event.message, id, entries, calls);
    return;
  }
  if (typeof event.result === 'string') {
    entries.push({ id, kind: 'agent', text: event.result });
    return;
  }
  if (event.role === 'user' || event.role === 'assistant') {
    const text =
      typeof event.content === 'string' ? event.content : contentText(event.content, 'text');
    if (text) entries.push({ id, kind: event.role === 'user' ? 'user' : 'agent', text });
  }
}

export function parseTranscript(content: string, userPrompt?: string): readonly TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const calls = new Set<string>();
  for (const [index, line] of content.split('\n').entries()) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isRecord(parsed)) parseEvent(parsed, `event-${index}`, entries, calls);
    } catch {
      // A partial live JSONL line is rendered after the next polling update.
    }
  }
  if (entries.length === 0 && content.trim()) {
    entries.push({ id: 'plain-transcript', kind: 'agent', text: content.trim() });
  }
  if (
    userPrompt &&
    !entries.some(
      (entry) =>
        entry.kind === 'user' && normalizedMessage(entry.text) === normalizedMessage(userPrompt),
    )
  ) {
    entries.unshift({ id: 'user-prompt', kind: 'user', text: userPrompt });
  }
  return entries;
}

export function groupTranscript(entries: readonly TranscriptEntry[]): readonly TranscriptGroup[] {
  const resultsByCall = new Map<string, TranscriptEntry[]>();
  for (const entry of entries) {
    if (entry.kind !== 'tool_result' || !entry.callId) continue;
    const results = resultsByCall.get(entry.callId) ?? [];
    results.push(entry);
    resultsByCall.set(entry.callId, results);
  }
  const matchedResults = new Set(
    entries
      .filter((entry) => entry.kind === 'tool_call' && entry.callId)
      .flatMap((entry) => resultsByCall.get(entry.callId ?? '') ?? [])
      .map(({ id }) => id),
  );
  return entries
    .filter((entry) => entry.kind !== 'tool_result' || !matchedResults.has(entry.id))
    .map((entry) => ({
      primary: entry,
      results:
        entry.kind === 'tool_call' && entry.callId ? (resultsByCall.get(entry.callId) ?? []) : [],
    }));
}
