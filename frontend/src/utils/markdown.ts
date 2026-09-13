/**
 * MindPal Markdown → Safe HTML renderer
 * Uses a lightweight regex-based converter then DOMPurify sanitization.
 */

import DOMPurify from 'dompurify';

/**
 * Convert a markdown string to a safe HTML string.
 * Handles: headers, bold, italic, inline code, code blocks, bullet lists,
 * numbered lists, blockquotes, horizontal rules, and paragraph breaks.
 */
export function markdownToHtml(md: string): string {
  if (!md) return '';

  let html = md
    // Escape raw HTML entities to prevent injection before our own tags are added
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

  // Bold + italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/__(.+?)__/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/_(.+?)_/g, '<em>$1</em>');

  // Horizontal rule
  html = html.replace(/^---+$/gm, '<hr class="mp-hr">');

  // Blockquote
  html = html.replace(/^&gt; (.+)$/gm, '<blockquote class="mp-blockquote">$1</blockquote>');

  // Unordered lists — collect consecutive `- ` or `* ` lines
  html = html.replace(/((?:^[-*] .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map((line) => {
      return `<li>${line.replace(/^[-*] /, '')}</li>`;
    });
    return `<ul class="mp-ul">${items.join('')}</ul>`;
  });

  // Ordered lists
  html = html.replace(/((?:^\d+\. .+\n?)+)/gm, (block) => {
    const items = block.trim().split('\n').map((line) => {
      return `<li>${line.replace(/^\d+\. /, '')}</li>`;
    });
    return `<ol class="mp-ol">${items.join('')}</ol>`;
  });

  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="mp-link" target="_blank" rel="noopener noreferrer">$1</a>');

  // Paragraph breaks — double newlines
  html = html.replace(/\n{2,}/g, '</p><p class="mp-p">');
  // Wrap single newlines within paragraphs
  html = html.replace(/\n/g, '<br>');
  // Wrap in paragraph tags if not already a block element
  if (!html.startsWith('<h') && !html.startsWith('<ul') && !html.startsWith('<ol') && !html.startsWith('<pre') && !html.startsWith('<blockquote')) {
    html = `<p class="mp-p">${html}</p>`;
  }

  // Sanitize with strict allow-list
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'p', 'br', 'strong', 'em', 'b', 'i', 'u', 's',
      'h1', 'h2', 'h3', 'h4',
      'ul', 'ol', 'li',
      'code', 'pre',
      'blockquote',
      'hr',
      'a',
    ],
    ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'input'],
  });
}

export const renderMarkdown = markdownToHtml;

