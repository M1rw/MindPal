import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check, HelpCircle } from 'lucide-react';
import { Modal } from './Modal';
import { useConfirmStore } from '../../store/confirm.ts';
import { cn } from '../../utils/ui/cn';

/** Both buttons share one size so the pair reads as a set, whatever the labels. */
const BUTTON =
  'inline-flex h-10 min-w-[6.5rem] items-center justify-center rounded-xl px-4 text-sm font-semibold transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--surface-card)]';

/**
 * Renders the request at the head of the confirm queue (store/confirm.ts).
 * Mounted once, in AppModals. Enter confirms, Esc and the backdrop cancel.
 */
export const ConfirmDialog: React.FC = () => {
  const request = useConfirmStore((state) => state.queue[0]);
  const settle = useConfirmStore((state) => state.settle);
  const [remember, setRemember] = useState(false);
  // Keep the last request on screen while the dialog animates out.
  const [shown, setShown] = useState(request);

  useEffect(() => {
    if (request) {
      setShown(request);
      setRemember(false);
    }
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
        <div className="flex items-start gap-3.5">
          <span
            className={cn(
              'flex h-10 w-10 flex-none items-center justify-center rounded-xl',
              danger ? 'bg-feedback-danger/10 text-feedback-danger' : 'bg-brand-primary/10 text-brand-primary',
            )}
            aria-hidden="true"
          >
            <Icon className="h-[18px] w-[18px]" />
          </span>
          <div className="min-w-0 pt-0.5">
            <h2 id={titleId} className="text-[15px] font-semibold leading-6 text-content-primary">
              {current.title}
            </h2>
            {current.message ? (
              <p className="mt-1 text-sm leading-relaxed text-content-secondary">{current.message}</p>
            ) : null}
          </div>
        </div>

        <div className="confirm-dialog__footer">
          {current.dontAskAgainKey ? (
            <button
              type="button"
              role="checkbox"
              aria-checked={remember}
              onClick={() => setRemember((value) => !value)}
              className="confirm-dialog__remember group"
            >
              <span
                className={cn(
                  'flex h-[18px] w-[18px] flex-none items-center justify-center rounded-[5px] border transition-colors duration-150',
                  remember
                    ? 'border-brand-primary bg-brand-primary text-white'
                    : 'border-edge-hover bg-transparent text-transparent group-hover:border-content-muted',
                )}
                aria-hidden="true"
              >
                <Check className="h-3 w-3" strokeWidth={3} />
              </span>
              <span>Don’t ask again</span>
            </button>
          ) : (
            <span className="hidden sm:block" />
          )}

          <div className="confirm-dialog__actions">
            <button
              type="button"
              onClick={cancel}
              // The safe choice for a destructive action starts focused.
              data-autofocus={danger ? '' : undefined}
              className={cn(
                BUTTON,
                'border border-edge-default bg-transparent text-content-primary hover:bg-surface-subtle focus-visible:ring-brand-primary',
              )}
            >
              {current.cancelLabel ?? 'Cancel'}
            </button>
            <button
              type="submit"
              data-autofocus={danger ? undefined : ''}
              className={cn(
                BUTTON,
                'border border-transparent text-white',
                danger
                  ? 'bg-feedback-danger hover:bg-feedback-danger/90 focus-visible:ring-feedback-danger'
                  : 'bg-brand-primary hover:bg-brand-hover focus-visible:ring-brand-primary',
              )}
            >
              {current.confirmLabel ?? 'Confirm'}
            </button>
          </div>
        </div>
      </form>
    </Modal>
  );
};
