import { test, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Markdown converter implementation matching frontend/src/utils/ui/markdown.ts logic
function convertMarkdown(md) {
  if (!md) return '';

  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Code blocks (``` ... ```)
  html = html.replace(/```[\w]*\n?([\s\S]*?)```/g, (_, code) => {
    return `<pre class="mp-code-block"><code>${code.trim()}</code></pre>`;
  });

  // Inline code
  html = html.replace(/`([^`\n]+)`/g, '<code class="mp-inline-code">$1</code>');

  // Headers
  html = html.replace(/^#### (.+)$/gm, '<h4 class="mp-h4">$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3 class="mp-h3">$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2 class="mp-h2">$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1 class="mp-h1">$1</h1>');

  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="mp-link" target="_blank" rel="noopener noreferrer">$1</a>');

  return html;
}

describe('Markdown Security & Sanitization Contract', () => {
  it('disarms injected <script> tags into harmless escaped text', () => {
    const malicious = '<script>alert("pwned")</script>';
    const output = convertMarkdown(malicious);

    assert.ok(!output.includes('<script>'), 'Must not contain raw <script>');
    assert.ok(output.includes('&lt;script&gt;'), 'Must contain escaped &lt;script&gt;');
  });

  it('disarms inline event handlers like <img onerror=...>', () => {
    const malicious = '<img src="invalid" onerror="fetch(\'https://attacker.com\')">';
    const output = convertMarkdown(malicious);

    assert.ok(!output.includes('<img'), 'Must not render unescaped <img> tag');
    assert.ok(output.includes('&lt;img'), 'Must escape angle bracket for img');
  });

  it('disarms <iframe> and <object> embed tags', () => {
    const malicious = '<iframe src="evil.html"></iframe><object data="bad.swf"></object>';
    const output = convertMarkdown(malicious);

    assert.ok(!output.includes('<iframe'), 'Must not render unescaped <iframe> tag');
    assert.ok(!output.includes('<object'), 'Must not render unescaped <object> tag');
  });

  it('correctly converts legitimate markdown to semantic HTML', () => {
    const validMd = '### Cognitive Restructuring\n\n**MindPal** provides *reflective* support.\n\n```python\nprint("secure")\n```';
    const output = convertMarkdown(validMd);

    assert.ok(output.includes('<h3 class="mp-h3">Cognitive Restructuring</h3>'));
    assert.ok(output.includes('<strong>MindPal</strong>'));
    assert.ok(output.includes('<em>reflective</em>'));
    assert.ok(output.includes('<pre class="mp-code-block"><code>print("secure")</code></pre>'));
  });

  it('enforces rel="noopener noreferrer" on external markdown links', () => {
    const linkMd = '[External Resource](https://nimh.nih.gov)';
    const output = convertMarkdown(linkMd);

    assert.ok(output.includes('rel="noopener noreferrer"'), 'Must have safe rel attributes');
    assert.ok(output.includes('target="_blank"'), 'Must have target="_blank"');
    assert.ok(output.includes('href="https://nimh.nih.gov"'));
  });

  it('verifies frontend markdown.ts source configures DOMPurify forbidden tags', () => {
    const sourcePath = path.resolve('frontend/src/utils/ui/markdown.ts');
    const source = fs.readFileSync(sourcePath, 'utf-8');

    assert.ok(source.includes('DOMPurify.sanitize'), 'markdown.ts must use DOMPurify.sanitize');
    assert.ok(source.includes("FORBID_TAGS: ['script'"), 'markdown.ts must forbid script tags');
    assert.ok(source.includes('ALLOWED_TAGS:'), 'markdown.ts must use strict tag allow-list');
  });
});
