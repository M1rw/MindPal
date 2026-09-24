import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, HelpCircle } from 'lucide-react';
import { Modal } from './Modal';
import { useConfirmStore } from '../../store/confirm.ts';
import { cn } from '../../utils/ui/cn';

/**
 * Renders the request at the head of the confirm queue (store/confirm.ts).
 * Mounted once, in AppModals. Enter confirms, Esc and the backdrop cancel.
 */
export const ConfirmDialog: React.FC = () => {
  const request = useConfirmStore((state) => state.queue[0]);
  const settle = useConfirmStore((state) => state.settle);
  const [remember, setRemember] = useState(false);
  const confirmRef = useRef<HTMLButtonElement>(null);
  // Keep the last request on screen while the dialog animates out.
  const [shown, setShown] = useState(request);

  useEffect(() => {
    if (request) {
      setShown(request);
      setRemember(false);
    }
  }, [request]);

  useEffect(() => {
    if (!request) return;
    // After the focus trap has placed focus: the safe choice for danger is Cancel.
    const timer = window.setTimeout(() => {
      if (request.tone !== 'danger') confirmRef.current?.focus({ preventScroll: true });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [request]);

  const current = request ?? shown;
  if (!current) return null;
  const danger = current.tone === 'danger';
  const Icon = current.icon ?? (danger ? AlertTriangle : HelpCircle);
  const titleId = `confirm-title-${current.id}`;
  const cancel = () => request && settle(request.id, false);
  const confirm = () => request && settle(request.id, true, remember);

  return (
    <Modal open={Boolean(request)} onClose={cancel} labelledBy={titleId} size="sm" layer={90}>
      <form
        className="confirm-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          confirm();
        }}
      >
        <div className="flex items-start gap-3">
          <span
            className={cn(
              'confirm-dialog__icon flex h-9 w-9 flex-none items-center justify-center rounded-full',
              danger ? 'bg-feedback-danger/10 text-feedback-danger' : 'bg-brand-primary/10 text-brand-primary',
            )}
            aria-hidden="true"
          >
            <Icon className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0 pt-1">
            <h2 id={titleId} className="text-base font-semibold text-content-primary">
              {current.title}
            </h2>
            {current.message ? (
              <p className="mt-1.5 text-sm leading-relaxed text-content-secondary">{current.message}</p>
            ) : null}
          </div>
        </div>

        {current.dontAskAgainKey ? (
          <label className="mt-4 flex cursor-pointer items-center gap-2 text-sm text-content-secondary select-none">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
              className="h-4 w-4 rounded border-edge-default accent-[var(--brand-primary)]"
            />
            Don’t ask again
          </label>
        ) : null}

        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button
            type="button"
            onClick={cancel}
            className="rounded-xl px-4 py-2.5 text-sm font-medium text-content-secondary bg-surface-sunken hover:bg-surface-elevated hover:text-content-primary transition-colors focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
          >
            {current.cancelLabel ?? 'Cancel'}
          </button>
          <button
            ref={confirmRef}
            type="submit"
            className={cn(
              'rounded-xl px-4 py-2.5 text-sm font-semibold text-white transition-colors focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
              danger
                ? 'bg-feedback-danger hover:opacity-90 focus-visible:ring-feedback-danger'
                : 'bg-brand-primary hover:bg-brand-hover focus-visible:ring-brand-primary',
            )}
          >
            {current.confirmLabel ?? 'Confirm'}
          </button>
        </div>
      </form>
    </Modal>
  );
};
