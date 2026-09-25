/**
 * Files v5.0.5 on the device: which pipeline a PDF page takes, page citations,
 * what a chat request carries, and the limits checked before any upload.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { routePage, textLayerGarbled, TEXT_PAGE_MIN_CHARS } from '../../frontend/src/files/pdf.ts';
import { citationTargets, withPageCitations } from '../../frontend/src/files/citations.ts';
import { checkLimits, runLimited } from '../../frontend/src/files/reader.ts';
import { rememberDigest } from '../../frontend/src/files/session.ts';
import { MAX_FILES_IN_CONTEXT, toMessageAttachment, turnAttachments } from '../../frontend/src/files/turnPayload.ts';
import { kindOf } from '../../frontend/src/files/types.ts';
import { sessionMessagesFingerprint } from '../../frontend/src/utils/chat/sessionHistory.ts';

const digest = (name) => ({
  version: 1, kind: 'pdf', content: 'text', name, title: name, summary: '', language: '', total_pages: 1,
  pages: [{ n: 1, kind: 'text', text: 'hello', description: '' }],
});

describe('PDF pages: the cheapest pipeline that reads them right', () => {
  it('keeps real text layers on the device and sends scans and figures to vision', () => {
    assert.equal(routePage(TEXT_PAGE_MIN_CHARS + 500, 0), false, 'a text page is read here');
    assert.equal(routePage(40, 0), true, 'a scan has almost no text layer');
    assert.equal(routePage(500, 2), true, 'mostly figure: worth a look');
    assert.equal(routePage(3000, 1), false, 'a long page with a logo is still a text page');
  });

  it('spots a garbled text layer: shaped Arabic glyphs or letters spaced one by one', () => {
    // Shaped (presentation form) Arabic, as pdf.js returns it from some PDFs.
    const shaped = Array.from({ length: 40 }, (_, i) => String.fromCodePoint(0xfe8d + (i % 30))).join(' ');
    assert.equal(textLayerGarbled(shaped), true);
    const arabic = 'يسمح بقطة واحدة فقط مع رسوم شهرية قدرها خمسة وعشرون دولارا ويجب الحفاظ على النظافة';
    assert.equal(textLayerGarbled(arabic), false, 'real Arabic text is fine');
    assert.equal(textLayerGarbled('The tenant pays a security deposit that is refundable after inspection.'), false);
    assert.equal(textLayerGarbled('T h e t e n a n t p a y s a d e p o s i t o f m o n e y'), true);
  });
});

describe('page citations', () => {
  it('turns [p. N] into a chip in text, never inside attributes', () => {
    const html = '<p>The deposit is refundable [p. 7] and <a href="/x[p. 3]">link</a> [pp. 12].</p>';
    const out = withPageCitations(html);
    assert.match(out, /<button type="button" class="page-cite" data-page="7" aria-label="Open page 7">p. 7<\/button>/);
    assert.match(out, /data-page="12"/);
    assert.match(out, /href="\/x\[p\. 3\]"/, 'attribute untouched');
  });

  it('points each reply at the newest PDF shared by then', () => {
    const lease = { id: 'a1', kind: 'pdf', name: 'lease.pdf' };
    const photo = { id: 'a2', kind: 'image', name: 'cat.jpg' };
    const report = { id: 'a3', kind: 'pdf', name: 'report.pdf' };
    const targets = citationTargets([
      { id: '1', role: 'assistant', content: 'hi', timestamp: '' },
      { id: '2', role: 'user', content: '', timestamp: '', attachments: [lease] },
      { id: '3', role: 'assistant', content: 'x', timestamp: '' },
      { id: '4', role: 'user', content: '', timestamp: '', attachments: [photo] },
      { id: '5', role: 'user', content: '', timestamp: '', attachments: [report] },
      { id: '6', role: 'assistant', content: 'y', timestamp: '' },
    ]);
    assert.deepEqual(targets.map((t) => t?.id), [undefined, 'a1', 'a1', 'a1', 'a3', 'a3']);
  });
});

describe('what a chat request carries', () => {
  it("sends this turn's files with their picture, and earlier ones marked, newest first", async () => {
    rememberDigest('old1', digest('old1.pdf'));
    rememberDigest('old2', digest('old2.pdf'));
    const history = [
      { id: 'm1', role: 'user', content: 'a', timestamp: '', attachments: [{ id: 'old1', kind: 'pdf', name: 'old1.pdf' }] },
      { id: 'm2', role: 'user', content: 'b', timestamp: '', attachments: [{ id: 'old2', kind: 'pdf', name: 'old2.pdf' }] },
      { id: 'm3', role: 'user', content: 'c', timestamp: '', attachments: [{ id: 'gone', kind: 'pdf', name: 'gone.pdf' }] },
    ];
    const fresh = [{
      id: 'new', kind: 'image', name: 'cat.jpg', status: 'ready', progress: { done: 1, total: 1 }, hash: 'h',
      previewUrls: [], digest: { ...digest('cat.jpg'), kind: 'image' }, turnImage: { data: 'AAAA', mime: 'image/jpeg' },
    }];
    const out = await turnAttachments({ fresh, history, signedIn: false });
    assert.equal(out[0].name, 'cat.jpg');
    assert.equal(out[0].image, 'AAAA');
    assert.equal(out[0].earlier, undefined);
    assert.deepEqual(out.slice(1).map((a) => [a.name, a.earlier, Boolean(a.image)]), [
      ['old2.pdf', true, false],
      ['old1.pdf', true, false],
    ], 'a file this device no longer has is skipped');
  });

  it('uses the library id for accounts, and never more than the server takes', async () => {
    const history = Array.from({ length: 12 }, (_, i) => ({
      id: `m${i}`, role: 'user', content: 'x', timestamp: '',
      attachments: [{ id: `f${i}`, kind: 'pdf', name: `f${i}.pdf`, fileId: `f_abcdef${String(i).padStart(3, '0')}` }],
    }));
    const out = await turnAttachments({ history, signedIn: true });
    assert.equal(out.length, MAX_FILES_IN_CONTEXT);
    assert.deepEqual(Object.keys(out[0]).sort(), ['earlier', 'file_id', 'name']);
  });

  it('keeps identity and shape on the message, never pictures or readings', () => {
    const message = toMessageAttachment({
      id: 'x', kind: 'pdf', name: 'a.pdf', mime: 'application/pdf', pages: 3, size: 10, status: 'ready',
      progress: { done: 3, total: 3 }, hash: 'h', previewUrls: ['blob:1'], thumbUrl: 'blob:2', digest: digest('a.pdf'),
    });
    assert.deepEqual(message, { id: 'x', kind: 'pdf', name: 'a.pdf', mime: 'application/pdf', pages: 3, size: 10 });
  });

  it('a file reaching the library after sending still counts as a change to save', () => {
    const before = [{ id: '1', role: 'user', content: '', attachments: [{ id: 'a', kind: 'pdf', name: 'a' }] }];
    const after = [{ id: '1', role: 'user', content: '', attachments: [{ id: 'a', kind: 'pdf', name: 'a', fileId: 'f_1' }] }];
    assert.notEqual(sessionMessagesFingerprint(before), sessionMessagesFingerprint(after));
  });
});

describe('limits checked before anything is uploaded', () => {
  const guest = { max_pdf_bytes: 10_000_000, max_image_bytes: 10_000_000, signed_in: false };
  it('refuses other types and oversized files with a reason', () => {
    assert.equal(kindOf('application/pdf'), 'pdf');
    assert.equal(kindOf('', 'Scan.PDF'), 'pdf');
    assert.equal(kindOf('image/heic'), 'image');
    assert.equal(kindOf('text/plain'), null);
    const big = { name: 'a.pdf', type: 'application/pdf', size: 11_000_000 };
    assert.match(checkLimits(big, guest), /up to 10 MB \(more when you sign in\)/);
    assert.equal(checkLimits({ name: 'b.exe', type: 'application/x-msdownload', size: 1 }, guest), 'Only images and PDFs can be attached.');
    assert.equal(checkLimits({ name: 'c.png', type: 'image/png', size: 1000 }, guest), null);
  });

  it('runs page batches a few at a time and stops at the first failure', async () => {
    let running = 0;
    let peak = 0;
    const done = [];
    const task = (n, fail = false) => async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 5));
      running -= 1;
      if (fail) throw new Error(`batch ${n} failed`);
      done.push(n);
    };
    await runLimited([1, 2, 3, 4, 5, 6].map((n) => task(n)), 3);
    assert.equal(peak, 3);
    assert.equal(done.length, 6);
    await assert.rejects(runLimited([task(1), task(2, true), task(3)], 1), /batch 2 failed/);
  });
});
