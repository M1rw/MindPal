/**
 * PDFs, read on the device first.
 *
 * Every page is classified before anything is sent: a page with a real text
 * layer is read right here (free, instant); a scanned page, or one that is
 * mostly figure, is rendered to an image for the vision pipeline. Most PDFs
 * people have (letters, reports, papers) never touch a model to be read.
 */
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { canvasToBlob, drawScaled } from './image.ts';

type PdfModule = typeof import('./pdfjs-entry.ts');

/** Fewer characters than this and the page is a scan (or a stray header on one). */
export const TEXT_PAGE_MIN_CHARS = 200;
/** A page with a picture and less text than this is mostly figure: worth a look. */
export const FIGURE_PAGE_MAX_CHARS = 900;
/** Long edge of a page rendered for reading. */
export const PAGE_READ_EDGE = 1400;

let modulePromise: Promise<PdfModule> | null = null;

export function loadPdfjs(): Promise<PdfModule> {
  if (!modulePromise) {
    const url = new URL('./pdf.bundle.js', import.meta.url).href;
    modulePromise = (import(/* @vite-ignore */ url) as Promise<PdfModule>).catch((error) => {
      modulePromise = null;
      throw error;
    });
  }
  return modulePromise;
}

/** The loading task owns a document's worker resources (pdf.js 5+); kept to release them. */
const tasks = new WeakMap<PDFDocumentProxy, { destroy: () => Promise<void> }>();

export async function openPdf(file: Blob): Promise<PDFDocumentProxy> {
  const pdfjs = await loadPdfjs();
  const task = pdfjs.getDocument({
    data: new Uint8Array(await file.arrayBuffer()),
    // A PDF is someone else's file: no XFA forms (pdf.js 6 generates no code
    // from fonts or functions and runs no document scripts).
    enableXfa: false,
  });
  try {
    const doc = await task.promise;
    tasks.set(doc, task);
    return doc;
  } catch (error) {
    void task.destroy();
    const name = (error as { name?: string })?.name;
    if (name === 'PasswordException') throw new Error('This PDF is password-protected. Remove the password and try again.');
    throw new Error("This PDF couldn't be opened. It may be damaged.");
  }
}

export interface PageInfo {
  n: number;
  text: string;
  /** Read by a vision model (scans, figures) rather than from its text layer. */
  needsVision: boolean;
}

export function closePdf(doc: PDFDocumentProxy): void {
  void tasks.get(doc)?.destroy();
  tasks.delete(doc);
}

/** Decide which pipeline a page takes, from its text length and its images. */
export function routePage(textChars: number, imageOps: number): boolean {
  if (textChars < TEXT_PAGE_MIN_CHARS) return true;
  return imageOps > 0 && textChars < FIGURE_PAGE_MAX_CHARS;
}

// Arabic (and Persian, Urdu) shaped glyphs: a text layer made of these is the
// page's drawing order, letter by letter, not its words.
function isShapedGlyph(code: number): boolean {
  return (code >= 0xfb50 && code <= 0xfdff) || (code >= 0xfe70 && code <= 0xfeff);
}

const LETTER = /\p{L}/gu;

/**
 * A text layer that is there but unreadable: shaped Arabic glyphs, or words
 * spelled out one letter at a time. Such a page is read by the vision model,
 * which reads the script as a person would.
 */
export function textLayerGarbled(text: string): boolean {
  const letters = text.match(LETTER)?.length ?? 0;
  if (letters < 20) return false;
  let shaped = 0;
  for (const char of text) if (isShapedGlyph(char.codePointAt(0) ?? 0)) shaped += 1;
  if (shaped / letters > 0.2) return true;
  const tokens = text.split(/\s+/).filter(Boolean);
  const single = tokens.filter((t) => [...t].length === 1).length;
  return tokens.length >= 12 && single / tokens.length > 0.6;
}

async function pageText(page: PDFPageProxy): Promise<string> {
  const content = await page.getTextContent();
  let out = '';
  for (const item of content.items) {
    if (!('str' in item)) continue;
    out += item.str;
    out += item.hasEOL ? '\n' : ' ';
  }
  return out.replace(/[ \t]+\n/g, '\n').trim();
}

async function imageOps(page: PDFPageProxy, pdfjs: PdfModule): Promise<number> {
  const ops = await page.getOperatorList();
  const painting = new Set([
    pdfjs.OPS.paintImageXObject,
    pdfjs.OPS.paintInlineImageXObject,
    pdfjs.OPS.paintImageMaskXObject,
    pdfjs.OPS.paintImageXObjectRepeat,
  ]);
  let count = 0;
  for (const fn of ops.fnArray) if (painting.has(fn)) count += 1;
  return count;
}

export async function analysePage(doc: PDFDocumentProxy, n: number): Promise<PageInfo> {
  const pdfjs = await loadPdfjs();
  const page = await doc.getPage(n);
  try {
    const text = await pageText(page);
    const needsVision =
      textLayerGarbled(text) || routePage(text.replace(/\s+/g, '').length, await imageOps(page, pdfjs));
    return { n, text, needsVision };
  } finally {
    page.cleanup();
  }
}

/** A page as an image, its long edge at most `maxEdge` px. */
export async function renderPage(doc: PDFDocumentProxy, n: number, maxEdge: number, quality = 0.82): Promise<Blob> {
  const page = await doc.getPage(n);
  try {
    const base = page.getViewport({ scale: 1 });
    const scale = Math.min(3, maxEdge / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Could not draw the page.');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    return await canvasToBlob(drawScaled(canvas, maxEdge), 'image/jpeg', quality);
  } finally {
    page.cleanup();
  }
}
