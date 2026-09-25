import React from 'react';
import { AlertCircle, FileText, X } from 'lucide-react';
import { cn } from '../../../utils/ui/cn';
import { useComposerFilesStore } from '../../../store/composerFiles.ts';
import type { PendingAttachment } from '../../../files/types.ts';

/** A ring that fills as pages are read. */
function ProgressRing({ done, total, size = 22 }: { done: number; total: number; size?: number }) {
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const fraction = total > 0 ? Math.min(1, done / total) : 0;
  // Nothing measurable yet: an indeterminate sweep instead of an empty ring.
  const spinning = fraction === 0;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={cn('composer-file__ring', spinning && 'composer-file__ring--spin')}
      aria-hidden="true"
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity="0.25" strokeWidth={stroke} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="currentColor"
        strokeWidth={stroke}
        strokeLinecap="round"
        strokeDasharray={c}
        strokeDashoffset={spinning ? c * 0.72 : c * (1 - fraction)}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
        style={{ transition: 'stroke-dashoffset 300ms ease-out' }}
      />
    </svg>
  );
}

function status(item: PendingAttachment): string {
  if (item.status === 'error') return item.error || "Couldn't read this file";
  if (item.status === 'reading') {
    if (item.kind === 'pdf' && item.progress.total > 1) return `Reading ${item.progress.done} of ${item.progress.total}`;
    return 'Reading…';
  }
  if (item.kind === 'pdf') return `${item.pages ?? item.progress.total} page${(item.pages ?? 1) === 1 ? '' : 's'}`;
  return 'Ready';
}

function RemoveButton({ item }: { item: PendingAttachment }) {
  const remove = useComposerFilesStore((state) => state.remove);
  return (
    <button
      type="button"
      onClick={() => remove(item.id)}
      className="composer-file__remove"
      aria-label={`Remove ${item.name}`}
      title="Remove"
    >
      <X className="h-3 w-3" aria-hidden="true" />
    </button>
  );
}

function ImageChip({ item }: { item: PendingAttachment }) {
  return (
    <div
      className={cn('composer-file composer-file--image', item.status === 'error' && 'composer-file--error')}
      title={`${item.name} — ${status(item)}`}
    >
      {item.thumbUrl ? <img src={item.thumbUrl} alt="" className="composer-file__img" draggable={false} /> : null}
      {item.status === 'reading' ? (
        <span className="composer-file__veil">
          <ProgressRing done={item.progress.done} total={item.progress.total} />
        </span>
      ) : null}
      {item.status === 'error' ? (
        <span className="composer-file__veil composer-file__veil--error">
          <AlertCircle className="h-5 w-5" aria-hidden="true" />
        </span>
      ) : null}
      <span className="sr-only">
        {item.name}: {status(item)}
      </span>
      <RemoveButton item={item} />
    </div>
  );
}

function PdfChip({ item }: { item: PendingAttachment }) {
  return (
    <div className={cn('composer-file composer-file--pdf', item.status === 'error' && 'composer-file--error')} title={item.name}>
      <span className="composer-file__page">
        {item.thumbUrl ? (
          <img src={item.thumbUrl} alt="" className="composer-file__img" draggable={false} />
        ) : (
          <FileText className="h-4 w-4 text-content-muted" aria-hidden="true" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13px] font-medium text-content-primary">{item.name}</span>
        <span
          className={cn('block truncate text-xs', item.status === 'error' ? 'text-feedback-danger' : 'text-content-secondary')}
          aria-live="polite"
        >
          {status(item)}
        </span>
      </span>
      {item.status === 'reading' ? <ProgressRing done={item.progress.done} total={item.progress.total} size={20} /> : null}
      <RemoveButton item={item} />
    </div>
  );
}

/** The files in the composer, above the text field. */
export const ComposerFiles: React.FC = () => {
  const items = useComposerFilesStore((state) => state.items);
  const notice = useComposerFilesStore((state) => state.notice);
  if (!items.length && !notice) return null;
  return (
    <div className="composer-files">
      {items.length ? (
        <div className="composer-files__row" role="list" aria-label="Attached files">
          {items.map((item) => (
            <div role="listitem" key={item.id} className="composer-files__item">
              {item.kind === 'pdf' ? <PdfChip item={item} /> : <ImageChip item={item} />}
            </div>
          ))}
        </div>
      ) : null}
      {notice ? (
        <p className="composer-files__notice" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
};
