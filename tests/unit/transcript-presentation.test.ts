import { describe, expect, test } from 'bun:test';

import type { ArtifactView } from '@kouro/api-contracts';

import {
  approvalDiffArtifact,
  formatByteSize,
  invocationDisplayState,
  invocationFailure,
} from '../../packages/web/src/execution-presentation.ts';
import { structuredValueMarkdown } from '../../packages/web/src/code-viewer.tsx';
import { groupTranscript, parseTranscript } from '../../packages/web/src/transcript.ts';

function gitDiffArtifact(id: string, invocationSequence: number): ArtifactView {
  return {
    id,
    runId: 'run-1',
    invocationSequence,
    attemptNumber: 0,
    kind: 'git_diff',
    mediaType: 'text/x-diff',
    checksum: `sha256:${invocationSequence}`,
    size: invocationSequence,
  };
}

describe('transcript presentation', () => {
  test('selects the diff from the exact approval invocation', () => {
    const current = gitDiffArtifact('2:0:git_diff', 2);

    expect(
      approvalDiffArtifact(
        [gitDiffArtifact('10:0:git_diff', 10), gitDiffArtifact('1:0:git_diff', 1), current],
        2,
      ),
    ).toBe(current);
  });

  test('selects a run-level delivery diff by its encoded invocation', () => {
    const current: ArtifactView = {
      id: '7:0:git_diff',
      runId: 'run-1',
      attemptNumber: 0,
      kind: 'git_diff',
      mediaType: 'text/x-diff',
      checksum: 'sha256:7',
      size: 7,
    };

    expect(
      approvalDiffArtifact(
        [gitDiffArtifact('6:0:git_diff', 6), current, gitDiffArtifact('8:0:git_diff', 8)],
        7,
      ),
    ).toBe(current);
  });

  test('shows user, reasoning, and agent messages', () => {
    const transcript = [
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'reason-1', type: 'reasoning', text: 'Inspect the existing behavior.' },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'message-1', type: 'agent_message', text: 'The change is complete.' },
      }),
    ].join('\n');

    expect(parseTranscript(transcript, 'Please implement the change.')).toEqual([
      {
        id: 'user-prompt',
        kind: 'user',
        text: 'Please implement the change.',
      },
      {
        id: 'event-0',
        kind: 'reasoning',
        text: 'Inspect the existing behavior.',
      },
      {
        id: 'event-1',
        kind: 'agent',
        text: 'The change is complete.',
      },
    ]);
  });

  test('does not repeat a prompt already emitted by the provider', () => {
    const transcript = [
      JSON.stringify({
        role: 'user',
        content: 'Please implement the change.',
      }),
      JSON.stringify({
        role: 'assistant',
        content: 'I will inspect the existing behavior.',
      }),
    ].join('\n');

    expect(parseTranscript(transcript, '  Please implement   the change. ')).toEqual([
      {
        id: 'event-0',
        kind: 'user',
        text: 'Please implement the change.',
      },
      {
        id: 'event-1',
        kind: 'agent',
        text: 'I will inspect the existing behavior.',
      },
    ]);
  });

  test('correlates parallel tool results by call ID instead of completion order', () => {
    const transcript = [
      JSON.stringify({
        type: 'item.started',
        item: { id: 'call-a', type: 'command_execution', command: 'bun test a' },
      }),
      JSON.stringify({
        type: 'item.started',
        item: { id: 'call-b', type: 'command_execution', command: 'bun test b' },
      }),
      JSON.stringify({
        type: 'item.started',
        item: { id: 'call-c', type: 'command_execution', command: 'bun test c' },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'call-c',
          type: 'command_execution',
          aggregated_output: 'C passed',
          exit_code: 0,
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'call-a',
          type: 'command_execution',
          aggregated_output: 'A passed',
          exit_code: 0,
        },
      }),
      JSON.stringify({
        type: 'item.completed',
        item: {
          id: 'call-b',
          type: 'command_execution',
          aggregated_output: 'B passed',
          exit_code: 0,
        },
      }),
    ].join('\n');

    const groups = groupTranscript(parseTranscript(transcript));
    expect(
      groups.map(({ primary, results }) => ({
        callId: primary.callId,
        command: primary.text,
        result: results[0]?.text,
      })),
    ).toEqual([
      { callId: 'call-a', command: 'bun test a', result: 'A passed' },
      { callId: 'call-b', command: 'bun test b', result: 'B passed' },
      { callId: 'call-c', command: 'bun test c', result: 'C passed' },
    ]);
  });

  test('formats structured tool data as readable Markdown fields', () => {
    expect(
      structuredValueMarkdown({
        command: 'bun test',
        options: { timeout: 30, verbose: true },
        files: ['src/a.ts', 'src/b.ts'],
      }),
    ).toBe(
      [
        '- **command**: `bun test`',
        '- **options.timeout**: `30`',
        '- **options.verbose**: `true`',
        '- **files**: `["src/a.ts","src/b.ts"]`',
      ].join('\n'),
    );
  });

  test('keeps an unmatched tool result visible', () => {
    const transcript = JSON.stringify({
      type: 'tool_result',
      toolCallId: 'external-call',
      toolName: 'read',
      result: 'file contents',
    });

    expect(groupTranscript(parseTranscript(transcript))[0]?.primary).toEqual(
      expect.objectContaining({
        kind: 'tool_result',
        callId: 'external-call',
        text: 'file contents',
      }),
    );
  });

  test('presents failed command outcomes and their stderr', () => {
    const invocation = {
      sequence: 2,
      nodeId: 'validate',
      state: 'succeeded',
      attempts: [{ number: 1, state: 'succeeded' }],
      outcome: 'failure',
      output: {
        exitCode: 1,
        stdout: '',
        stderr: 'Typecheck failed on src/index.ts',
      },
    } as const;

    expect(invocationDisplayState(invocation)).toBe('failed');
    expect(invocationFailure(invocation)).toEqual({
      kind: 'command failure',
      message: 'Typecheck failed on src/index.ts',
    });
  });

  test('presents durable agent failure messages', () => {
    const invocation = {
      sequence: 3,
      nodeId: 'implement',
      state: 'failed',
      attempts: [
        {
          number: 1,
          state: 'failed',
          failure: {
            kind: 'harness_failure',
            message: 'Provider rejected the request',
          },
        },
      ],
    } as const;

    expect(invocationFailure(invocation)).toEqual({
      kind: 'harness_failure',
      message: 'Provider rejected the request',
    });
  });

  test('formats artifact sizes with compact binary units', () => {
    expect(formatByteSize(892)).toBe('892 B');
    expect(formatByteSize(1536)).toBe('1.5 KiB');
    expect(formatByteSize(398_230_945_820_139)).toBe('362 TiB');
  });
});
