import { type ReactElement, type ReactNode } from 'react';

export type CodeLanguage =
  | 'diff'
  | 'json'
  | 'markdown'
  | 'shell'
  | 'text'
  | 'typescript';

interface CodeViewerProps {
  readonly content: string;
  readonly label: string;
  readonly language: CodeLanguage;
  readonly compact?: boolean;
}

const jsonToken =
  /("(?:[^"\\]|\\.)*")(\s*:\s*)?|(\btrue\b|\bfalse\b|\bnull\b)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;
const programmingToken =
  /(\/\/.*$|#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|(\b(?:async|await|break|case|catch|class|const|continue|default|do|else|export|extends|false|finally|for|from|function|if|import|in|interface|let|new|null|of|return|switch|throw|true|try|type|undefined|while)\b)|(\b\d+(?:\.\d+)?\b)/g;
const shellToken =
  /(#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\B--?[\w-]+)|(\b\d+(?:\.\d+)?\b)/g;

function highlightedTokens(
  line: string,
  expression: RegExp,
  classFor: (match: RegExpExecArray) => string | undefined,
): readonly ReactNode[] {
  const parts: ReactNode[] = [];
  let last = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(line)) !== null) {
    if (match.index > last) parts.push(line.slice(last, match.index));
    const className = classFor(match);
    parts.push(
      className ? (
        <span className={className} key={key++}>
          {match[0]}
        </span>
      ) : (
        match[0]
      ),
    );
    last = expression.lastIndex;
  }
  if (last < line.length) parts.push(line.slice(last));
  return parts;
}

function highlightLine(line: string, language: CodeLanguage): ReactNode {
  if (language === 'diff') {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      return <span className="syntax-diff-add">{line}</span>;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      return <span className="syntax-diff-remove">{line}</span>;
    }
    if (line.startsWith('@@')) return <span className="syntax-diff-hunk">{line}</span>;
    if (line.startsWith('diff ') || line.startsWith('index ')) {
      return <span className="syntax-keyword">{line}</span>;
    }
    return line;
  }
  if (language === 'json') {
    return highlightedTokens(line, jsonToken, (match) => {
      if (match[1]) return match[2] ? 'syntax-key' : 'syntax-string';
      if (match[3]) return match[3] === 'null' ? 'syntax-null' : 'syntax-bool';
      if (match[4]) return 'syntax-number';
      return undefined;
    });
  }
  if (language === 'shell') {
    return highlightedTokens(line, shellToken, (match) => {
      if (match[1]) return 'syntax-comment';
      if (match[2]) return 'syntax-string';
      if (match[3]) return 'syntax-parameter';
      if (match[4]) return 'syntax-number';
      return undefined;
    });
  }
  if (language === 'typescript') {
    return highlightedTokens(line, programmingToken, (match) => {
      if (match[1]) return 'syntax-comment';
      if (match[2]) return 'syntax-string';
      if (match[3]) return 'syntax-keyword';
      if (match[4]) return 'syntax-number';
      return undefined;
    });
  }
  return line;
}

export function CodeViewer({
  content,
  label,
  language,
  compact = false,
}: CodeViewerProps): ReactElement {
  const lines = content.split('\n');
  return (
    <section className={`code-viewer${compact ? ' compact' : ''}`}>
      <header>
        <span className="editor-dots" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <span className="editor-label">{label}</span>
        <span className="editor-language">{language}</span>
      </header>
      <pre>
        <code>
          {lines.map((line, index) => (
            <span className="code-line" key={index}>
              <span className="line-number">{index + 1}</span>
              <span className="line-content">{highlightLine(line, language) || ' '}</span>
            </span>
          ))}
        </code>
      </pre>
    </section>
  );
}

function inlineMarkdown(text: string): readonly ReactNode[] {
  const parts: ReactNode[] = [];
  const expression = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)]+\))/g;
  let last = 0;
  let key = 0;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    const token = match[0];
    const link = /^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/.exec(token);
    if (link) {
      parts.push(
        <a href={link[2]} key={key++} rel="noreferrer" target="_blank">
          {link[1]}
        </a>,
      );
    } else if (token.startsWith('**')) {
      parts.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else {
      parts.push(<code key={key++}>{token.slice(1, -1)}</code>);
    }
    last = expression.lastIndex;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

function codeLanguage(value: string): CodeLanguage {
  switch (value.trim().toLowerCase()) {
    case 'bash':
    case 'sh':
    case 'shell':
      return 'shell';
    case 'diff':
    case 'patch':
      return 'diff';
    case 'json':
    case 'jsonc':
      return 'json';
    case 'js':
    case 'javascript':
    case 'ts':
    case 'tsx':
    case 'typescript':
      return 'typescript';
    case 'md':
    case 'markdown':
      return 'markdown';
    default:
      return 'text';
  }
}

function markdownScalar(value: unknown): string {
  const displayed = typeof value === 'string' ? value : JSON.stringify(value);
  return `\`${(displayed ?? String(value)).replaceAll('`', "'")}\``;
}

function markdownFields(
  value: unknown,
  path: string,
  fields: string[],
): void {
  if (Array.isArray(value)) {
    if (value.every((item) => item === null || typeof item !== 'object')) {
      fields.push(`- **${path || 'value'}**: ${markdownScalar(value)}`);
      return;
    }
    value.forEach((item, index) =>
      markdownFields(item, `${path || 'value'}[${index}]`, fields),
    );
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      markdownFields(child, path ? `${path}.${key}` : key, fields);
    }
    return;
  }
  fields.push(`- **${path || 'value'}**: ${markdownScalar(value)}`);
}

/** Converts structured tool data into a compact Markdown field list. */
export function structuredValueMarkdown(value: unknown): string {
  const fields: string[] = [];
  markdownFields(value, '', fields);
  return fields.join('\n') || '_No data_';
}

interface MarkdownBlock {
  readonly kind: 'code' | 'heading' | 'list' | 'paragraph' | 'quote';
  readonly content: string;
  readonly language?: CodeLanguage;
  readonly level?: number;
  readonly ordered?: boolean;
}

function markdownBlocks(content: string): readonly MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = content.split('\n');
  for (let index = 0; index < lines.length; ) {
    const line = lines[index] ?? '';
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = /^```(\S*)\s*$/.exec(line);
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? '')) {
        code.push(lines[index] ?? '');
        index += 1;
      }
      blocks.push({
        kind: 'code',
        content: code.join('\n'),
        language: codeLanguage(fence[1] ?? ''),
      });
      index += 1;
      continue;
    }
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      blocks.push({
        kind: 'heading',
        content: heading[2] ?? '',
        level: heading[1]?.length ?? 1,
      });
      index += 1;
      continue;
    }
    const list = /^(\s*)([-*]|\d+\.)\s+(.+)$/.exec(line);
    if (list) {
      const items: string[] = [];
      const ordered = /\d+\./.test(list[2] ?? '');
      while (index < lines.length) {
        const item = /^(\s*)([-*]|\d+\.)\s+(.+)$/.exec(lines[index] ?? '');
        if (!item || /\d+\./.test(item[2] ?? '') !== ordered) break;
        items.push(item[3] ?? '');
        index += 1;
      }
      blocks.push({ kind: 'list', content: items.join('\n'), ordered });
      continue;
    }
    if (line.startsWith('> ')) {
      const quote: string[] = [];
      while (index < lines.length && (lines[index] ?? '').startsWith('> ')) {
        quote.push((lines[index] ?? '').slice(2));
        index += 1;
      }
      blocks.push({ kind: 'quote', content: quote.join('\n') });
      continue;
    }
    const paragraph = [line];
    index += 1;
    while (
      index < lines.length &&
      (lines[index] ?? '').trim() &&
      !/^(#{1,4})\s+|^```|^(\s*)([-*]|\d+\.)\s+|^> /.test(lines[index] ?? '')
    ) {
      paragraph.push(lines[index] ?? '');
      index += 1;
    }
    blocks.push({ kind: 'paragraph', content: paragraph.join('\n') });
  }
  return blocks;
}

export function MarkdownContent({ content }: { readonly content: string }): ReactElement {
  return (
    <div className="markdown-content">
      {markdownBlocks(content).map((block, index) => {
        if (block.kind === 'code') {
          return (
            <CodeViewer
              compact
              content={block.content}
              key={index}
              label="code"
              language={block.language ?? 'text'}
            />
          );
        }
        if (block.kind === 'heading') {
          const Heading = block.level === 1 ? 'h2' : block.level === 2 ? 'h3' : 'h4';
          return <Heading key={index}>{inlineMarkdown(block.content)}</Heading>;
        }
        if (block.kind === 'list') {
          const List = block.ordered ? 'ol' : 'ul';
          return (
            <List key={index}>
              {block.content.split('\n').map((item, itemIndex) => (
                <li key={itemIndex}>{inlineMarkdown(item)}</li>
              ))}
            </List>
          );
        }
        if (block.kind === 'quote') {
          return <blockquote key={index}>{inlineMarkdown(block.content)}</blockquote>;
        }
        return <p key={index}>{inlineMarkdown(block.content)}</p>;
      })}
    </div>
  );
}
