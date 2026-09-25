/**
 * Reading a file into a digest, as fast as the file allows.
 *
 * Images: downscaled and hashed here, then one vision call decides what kind
 * of picture it is and reads it. PDFs: every page is classified here first;
 * text pages go up as text (no model), scanned or figure pages are rendered and
 * read by a vision model in batches, several batches at once. Progress is
 * reported per page, so the chip can say "Reading 7 of 12".
 */
import { filesApi, type DigestPageIn } from './api.ts';
import { blobToBase64, prepareImage, sha256Hex, THUMB_EDGE } from './image.ts';
import { analysePage, closePdf, openPdf, PAGE_READ_EDGE, renderPage, type PageInfo } from './pdf.ts';
import { kindOf, type Digest, type FileAllowance, type PageDigest } from './types.ts';

/** Page pictures kept for the animated PDF card. */
export const PDF_PREVIEWS = 6;
const VISION_BATCH = 6;
const PARALLEL_REQUESTS = 3;
/** Stay well under the 4 MB request cap per batch. */
const BATCH_BYTES = 3_200_000;
const TEXT_BATCH_PAGES = 25;

export interface ReadOutcome {
  digest: Digest;
  hash: string;
  pages: number;
  thumb: Blob;
  previews: Blob[];
  /** Pictures only: the copy sent with the first chat turn. */
  turnImage?: { data: string; mime: string };
}

export type Progress = (done: number, total: number) => void;

/** Checks the browser can make before spending any time on a file. */
export function checkLimits(file: File, limits: FileAllowance | null): string | null {
  const kind = kindOf(file.type, file.name);
  if (!kind) return 'Only images and PDFs can be attached.';
  if (!limits) return null;
  const max = kind === 'pdf' ? limits.max_pdf_bytes : limits.max_image_bytes;
  if (file.size > max) {
    const mb = Math.round(max / 1_000_000);
    return `${kind === 'pdf' ? 'PDFs' : 'Images'} can be up to ${mb} MB${limits.signed_in ? '' : ' (more when you sign in)'}.`;
  }
  return null;
}

export async function readFile(file: File, limits: FileAllowance | null, onProgress: Progress): Promise<ReadOutcome> {
  const kind = kindOf(file.type, file.name);
  if (kind === 'image') return readImage(file, onProgress);
  if (kind === 'pdf') return readPdf(file, limits, onProgress);
  throw new Error('Only images and PDFs can be attached.');
}

async function readImage(file: File, onProgress: Progress): Promise<ReadOutcome> {
  onProgress(0, 1);
  const [hash, prepared] = await Promise.all([sha256Hex(file), prepareImage(file)]);
  const digest = await filesApi.digestImage(prepared.read, hash, file.name);
  onProgress(1, 1);
  return {
    digest,
    hash,
    pages: 1,
    thumb: prepared.thumb,
    previews: [],
    turnImage: { data: await blobToBase64(prepared.turn), mime: 'image/jpeg' },
  };
}

async function readPdf(file: File, limits: FileAllowance | null, onProgress: Progress): Promise<ReadOutcome> {
  const [hash, doc] = await Promise.all([sha256Hex(file), openPdf(file)]);
  try {
    const total = doc.numPages;
    if (limits && total > limits.max_pdf_pages) {
      throw new Error(
        `PDFs can be up to ${limits.max_pdf_pages} pages${limits.signed_in ? '' : ' (more when you sign in)'}. This one has ${total}.`,
      );
    }
    onProgress(0, total);
    // Pictures first, so the card has pages to show while the rest is read.
    const previews: Blob[] = [];
    for (let n = 1; n <= Math.min(PDF_PREVIEWS, total); n += 1) previews.push(await renderPage(doc, n, THUMB_EDGE, 0.78));

    const info: PageInfo[] = [];
    for (let n = 1; n <= total; n += 1) info.push(await analysePage(doc, n));

    let done = 0;
    const tick = (count: number) => {
      done += count;
      onProgress(Math.min(done, total), total);
    };
    const results: PageDigest[] = [];
    const tasks: Array<() => Promise<void>> = [];

    const textPages = info.filter((p) => !p.needsVision);
    for (let i = 0; i < textPages.length; i += TEXT_BATCH_PAGES) {
      const batch = textPages.slice(i, i + TEXT_BATCH_PAGES);
      tasks.push(async () => {
        const pages = await filesApi.digestPages(hash, file.name, total, batch.map((p) => ({ n: p.n, text: p.text })));
        results.push(...pages);
        tick(batch.length);
      });
    }

    const visionPages = info.filter((p) => p.needsVision);
    for (let i = 0; i < visionPages.length; i += VISION_BATCH) {
      const batch = visionPages.slice(i, i + VISION_BATCH);
      tasks.push(async () => {
        const payload: DigestPageIn[] = [];
        let bytes = 0;
        for (const page of batch) {
          // Rendered when its batch starts, so only a few pages sit in memory.
          const image = await blobToBase64(await renderPage(doc, page.n, PAGE_READ_EDGE));
          bytes += image.length;
          payload.push({ n: page.n, text: page.text, image: bytes < BATCH_BYTES ? image : '', mime: 'image/jpeg' });
        }
        const pages = await filesApi.digestPages(hash, file.name, total, payload);
        results.push(...pages);
        tick(batch.length);
      });
    }

    await runLimited(tasks, PARALLEL_REQUESTS);
    const digest = await filesApi.assemble(file.name, total, results.sort((a, b) => a.n - b.n));
    return { digest, hash, pages: total, thumb: previews[0], previews };
  } finally {
    closePdf(doc);
  }
}

export async function runLimited(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  let next = 0;
  let failure: unknown = null;
  const worker = async () => {
    while (next < tasks.length && failure === null) {
      const task = tasks[next];
      next += 1;
      try {
        await task();
      } catch (error) {
        failure = error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  if (failure !== null) throw failure;
}
