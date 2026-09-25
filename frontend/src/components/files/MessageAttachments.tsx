import React from 'react';
import { FileText, ImageIcon } from 'lucide-react';
import { cn } from '../../utils/ui/cn';
import { useAttachmentPictures } from '../../files/pictures.ts';
import type { MessageAttachment } from '../../files/types.ts';
import { useLibraryStore } from '../../store/library.ts';

function open(attachment: MessageAttachment, page?: number) {
  useLibraryStore.getState().openViewer({ attachment, page });
}

function ImageTile({ attachment, single }: { attachment: MessageAttachment; single: boolean }) {
  const pictures = useAttachmentPictures(attachment);
  return (
    <button
      type="button"
      className={cn('msg-file-image', single && 'msg-file-image--single', pictures === undefined && 'is-loading')}
      onClick={() => open(attachment)}
      aria-label={`Open ${attachment.name}`}
      title={attachment.name}
    >
      {pictures?.thumbUrl ? (
        <img src={pictures.thumbUrl} alt={attachment.name} draggable={false} />
      ) : (
        <ImageIcon className="h-5 w-5 text-content-muted" aria-hidden="true" />
      )}
    </button>
  );
}

/** A PDF as a small stack of its pages that fans out on hover. */
function PdfCard({ attachment }: { attachment: MessageAttachment }) {
  const pictures = useAttachmentPictures(attachment);
  const pages = (pictures?.previewUrls.length ? pictures.previewUrls : pictures?.thumbUrl ? [pictures.thumbUrl] : []).slice(0, 3);
  const count = attachment.pages ?? 0;
  return (
    <button
      type="button"
      className="msg-file-pdf"
      onClick={() => open(attachment)}
      aria-label={`Open ${attachment.name}${count ? `, ${count} pages` : ''}`}
      title={attachment.name}
    >
      <span className={cn('msg-file-pdf__stack', pages.length > 1 && 'msg-file-pdf__stack--fan')} aria-hidden="true">
        {pages.length ? (
          pages
            .map((url, index) => (
              <span key={url} className="msg-file-pdf__page" style={{ '--i': index } as React.CSSProperties}>
                <img src={url} alt="" draggable={false} />
              </span>
            ))
            .reverse()
        ) : (
          <span className="msg-file-pdf__page msg-file-pdf__page--blank">
            <FileText className="h-5 w-5 text-content-muted" />
          </span>
        )}
      </span>
      <span className="msg-file-pdf__meta">
        <span className="msg-file-pdf__name">{attachment.name}</span>
        <span className="msg-file-pdf__sub">
          PDF{count ? ` · ${count} page${count === 1 ? '' : 's'}` : ''}
        </span>
      </span>
    </button>
  );
}

/** The files a message was sent with, above its text. */
export const MessageAttachments: React.FC<{ attachments: MessageAttachment[]; animate?: boolean }> = ({ attachments, animate }) => {
  if (!attachments.length) return null;
  const images = attachments.filter((a) => a.kind === 'image');
  const pdfs = attachments.filter((a) => a.kind === 'pdf');
  return (
    <div className={cn('msg-files', animate && 'msg-files--enter')}>
      {images.length ? (
        <div className={cn('msg-files__images', `msg-files__images--${Math.min(images.length, 4)}`)}>
          {images.map((attachment) => (
            <ImageTile key={attachment.id} attachment={attachment} single={images.length === 1} />
          ))}
        </div>
      ) : null}
      {pdfs.map((attachment) => (
        <PdfCard key={attachment.id} attachment={attachment} />
      ))}
    </div>
  );
};
