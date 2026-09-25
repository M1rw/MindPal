import React, { useEffect, useRef, useState } from 'react';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { MessageSquarePlus, ZoomIn, ZoomOut } from 'lucide-react';
import { Modal, ModalClose } from '../ui/Modal';
import { cn } from '../../utils/ui/cn';
import { useLibraryStore } from '../../store/library.ts';
import { useChatStore } from '../../store';
import { loadOriginal } from '../../files/pictures.ts';
import { closePdf, openPdf } from '../../files/pdf.ts';
import { sessionDigest } from '../../files/session.ts';
import { getLocalFile } from '../../files/localStore.ts';
import { attachExisting } from '../../files/attachExisting.ts';
import type { Digest } from '../../files/types.ts';

type Source =
  | { state: 'loading' }
  | { state: 'image'; url: string }
  | { state: 'pdf'; doc: PDFDocumentProxy }
  | { state: 'missing'; digest?: Digest };

/**
 * A page of a document that may already be closed (the viewer moved on while a
 * page was still scrolling in): pdf.js throws synchronously then, so it is
 * turned into a quiet rejection instead of taking the view down.
 */
function pageOf(doc: PDFDocumentProxy, n: number) {
  return Promise.resolve().then(() => doc.getPage(n));
}

/** One PDF page, drawn when it scrolls near the view. */
function PdfPage({ doc, n, width, onVisible }: { doc: PDFDocumentProxy; n: number; width: number; onVisible: (n: number) => void }) {
  const holder = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [ratio, setRatio] = useState(1.294);
  // The width it was last drawn at: redrawn when the viewer grows, so it stays sharp.
  const drawnAt = useRef(0);

  useEffect(() => {
    let cancelled = false;
    pageOf(doc, n)
      .then((page) => {
        const view = page.getViewport({ scale: 1 });
        if (!cancelled) setRatio(view.height / view.width);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [doc, n]);

  useEffect(() => {
    const node = holder.current;
    if (!node) return;
    const near = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && width - drawnAt.current > 80) {
          drawnAt.current = width;
          void pageOf(doc, n).then(async (page) => {
            const target = canvas.current;
            if (!target) return;
            const dpr = Math.min(2, window.devicePixelRatio || 1);
            const base = page.getViewport({ scale: 1 });
            const viewport = page.getViewport({ scale: (width * dpr) / base.width });
            target.width = Math.ceil(viewport.width);
            target.height = Math.ceil(viewport.height);
            const ctx = target.getContext('2d');
            if (!ctx) return;
            await page.render({ canvas: target, canvasContext: ctx, viewport }).promise.catch(() => {});
            target.classList.add('is-drawn');
          }).catch(() => {});
        }
      },
      { rootMargin: '600px 0px' },
    );
    // The current page is the one crossing the middle of the viewer (a tall page
    // is rarely more than half visible, so a visibility threshold never fires).
    const current = new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && onVisible(n)), {
      root: node.closest('.file-viewer__body'),
      rootMargin: '-50% 0px -50% 0px',
    });
    near.observe(node);
    current.observe(node);
    return () => {
      near.disconnect();
      current.disconnect();
    };
  }, [doc, n, width, onVisible]);

  return (
    <div ref={holder} className="file-viewer__page" data-page={n} style={{ aspectRatio: `1 / ${ratio}` }}>
      <canvas ref={canvas} aria-label={`Page ${n}`} />
    </div>
  );
}

export const FileViewer: React.FC = () => {
  const target = useLibraryStore((state) => state.viewer);
  const closeViewer = useLibraryStore((state) => state.closeViewer);
  const [source, setSource] = useState<Source>({ state: 'loading' });
  const [page, setPage] = useState(1);
  // What "Ask about page" uses: the page on screen at the moment of the tap.
  const pageRef = useRef(1);
  pageRef.current = page;
  const [zoomed, setZoomed] = useState(false);
  const [width, setWidth] = useState(720);
  const scroller = useRef<HTMLDivElement>(null);
  const open = Boolean(target);

  useEffect(() => {
    if (!target) return;
    let cancelled = false;
    let url = '';
    let doc: PDFDocumentProxy | null = null;
    setSource({ state: 'loading' });
    setPage(target.page ?? 1);
    setZoomed(false);
    void (async () => {
      try {
        const blob = await loadOriginal(target.attachment);
        if (cancelled) return;
        if (!blob) {
          const digest = sessionDigest(target.attachment.id) ?? (await getLocalFile(target.attachment.id))?.digest;
          setSource({ state: 'missing', digest });
          return;
        }
        if (target.attachment.kind === 'pdf') {
          doc = await openPdf(blob);
          if (!cancelled) setSource({ state: 'pdf', doc });
        } else {
          url = URL.createObjectURL(blob);
          setSource({ state: 'image', url });
        }
      } catch {
        if (!cancelled) setSource({ state: 'missing', digest: sessionDigest(target.attachment.id) });
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
      if (doc) closePdf(doc);
    };
  }, [target]);

  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const measure = () => setWidth(Math.min(900, node.clientWidth - 32));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [source.state]);

  // Open a cited page: scroll to it once the pages exist.
  useEffect(() => {
    if (source.state !== 'pdf' || !target?.page) return;
    window.requestAnimationFrame(() => {
      scroller.current?.querySelector(`[data-page="${target.page}"]`)?.scrollIntoView({ block: 'start' });
    });
  }, [source.state, target?.page]);

  const askAboutPage = async () => {
    if (!target) return;
    const { attachment } = target;
    const onScreen = pageRef.current;
    // Opened from the library into another chat: the file comes along with the question.
    const inChat = useChatStore
      .getState()
      .messages.some((m) => m.attachments?.some((a) => a.id === attachment.id || (a.fileId && a.fileId === attachment.fileId)));
    if (!inChat) {
      await attachExisting(attachment.fileId ? { fileId: attachment.fileId } : { localId: attachment.id }).catch(() => {});
    }
    useChatStore.getState().setComposerDraft(`About page ${onScreen} of ${attachment.name}: `);
    closeViewer();
    useLibraryStore.getState().close();
  };

  const total = source.state === 'pdf' ? source.doc.numPages : 0;

  return (
    <Modal open={open} onClose={closeViewer} label={target?.attachment.name ?? 'File'} size="panel" flush layer={80}>
      <div className="file-viewer">
        <div className="file-viewer__bar">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-content-primary">{target?.attachment.name}</p>
            {total ? (
              <p className="text-xs text-content-secondary" aria-live="polite">
                Page {page} of {total}
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-1">
            {source.state === 'image' ? (
              <button
                type="button"
                className="icon-hit mp-modal__close"
                onClick={() => setZoomed((z) => !z)}
                aria-label={zoomed ? 'Zoom out' : 'Zoom in'}
              >
                {zoomed ? <ZoomOut className="h-4 w-4" /> : <ZoomIn className="h-4 w-4" />}
              </button>
            ) : null}
            <ModalClose onClick={closeViewer} label="Close viewer" />
          </div>
        </div>

        <div ref={scroller} className={cn('file-viewer__body custom-scrollbar', zoomed && 'is-zoomed')}>
          {source.state === 'loading' ? <div className="file-viewer__loading" aria-label="Opening the file" /> : null}
          {source.state === 'image' ? (
            <img
              src={source.url}
              alt={target?.attachment.name}
              className={cn('file-viewer__image', zoomed && 'is-zoomed')}
              onClick={() => setZoomed((z) => !z)}
            />
          ) : null}
          {source.state === 'pdf'
            ? Array.from({ length: total }, (_, index) => (
                <PdfPage key={index + 1} doc={source.doc} n={index + 1} width={width} onVisible={setPage} />
              ))
            : null}
          {source.state === 'missing' ? (
            <div className="file-viewer__missing">
              <p className="text-sm font-medium text-content-primary">This file isn't on this device.</p>
              {source.digest?.summary ? (
                <p className="mt-2 text-sm text-content-secondary">What MindPal read: {source.digest.summary}</p>
              ) : null}
            </div>
          ) : null}
        </div>

        {source.state === 'pdf' ? (
          <div className="file-viewer__actions">
            <button type="button" className="file-viewer__ask" onClick={() => void askAboutPage()}>
              <MessageSquarePlus className="h-4 w-4" aria-hidden="true" />
              Ask about page {page}
            </button>
          </div>
        ) : null}
      </div>
    </Modal>
  );
};
