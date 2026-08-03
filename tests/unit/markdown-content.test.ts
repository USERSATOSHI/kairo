import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MarkdownContent } from '../../packages/web/src/code-viewer.tsx';

describe('MarkdownContent', () => {
  test('renders ticket Markdown without accepting raw HTML', () => {
    const markup = renderToStaticMarkup(
      createElement(MarkdownContent, {
        content: [
          '# Summary',
          '',
          '- **Ready**',
          '',
          '[Review](https://example.com/review)',
          '',
          '```ts',
          'const ready = true;',
          '```',
          '',
          '<script>alert("unsafe")</script>',
        ].join('\n'),
      }),
    );

    expect(markup).toContain('<h2>Summary</h2>');
    expect(markup).toContain('<li><strong>Ready</strong></li>');
    expect(markup).toContain('href="https://example.com/review"');
    expect(markup).toContain('class="code-viewer compact"');
    expect(markup).toContain('&lt;script&gt;alert(&quot;unsafe&quot;)&lt;/script&gt;');
    expect(markup).not.toContain('<script>');
  });
});
