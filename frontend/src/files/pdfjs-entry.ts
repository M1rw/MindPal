/**
 * pdf.js, built as its own bundle (frontend/dist/pdf.bundle.js) and loaded only
 * when someone attaches or opens a PDF, so it never weighs on the app's first
 * load. The worker is a sibling file (frontend/dist/pdf.worker.js).
 */
import { GlobalWorkerOptions } from 'pdfjs-dist';

GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.js', import.meta.url).href;

export { getDocument, OPS, version } from 'pdfjs-dist';
