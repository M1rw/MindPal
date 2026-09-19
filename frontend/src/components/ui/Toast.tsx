import React from 'react';
import { AlertTriangle, Check, Info, X, XCircle } from 'lucide-react';
import { useToastStore } from '../../store';
import type { ToastItem, ToastKind } from '../../types';
import { cn } from '../../utils/ui/cn';

const KIND: Record<
  ToastKind,
  {
    Icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
    well: string;
    glyph: string;
  }
> = {
  success: {
    Icon: Check,
    well: 'bg-feedback-successSubtle',
    glyph: 'text-feedback-success',
  },
  error: {
    Icon: XCircle,
    well: 'bg-feedback-dangerSubtle',
    glyph: 'text-feedback-danger',
  },
  warning: {
    Icon: AlertTriangle,
    well: 'bg-feedback-warningSubtle',
    glyph: 'text-feedback-warning',
  },
  info: {
    Icon: Info,
    well: 'bg-brand-subtle',
    glyph: 'text-brand-primary',
  },
};

const ToastEntry: React.FC<{ toast: ToastItem }> = ({ toast }) => {
  const { dismiss } = useToastStore();
  const cfg = KIND[toast.kind] ?? KIND.info;
  const Icon = cfg.Icon;
  const live = toast.kind === 'error' || toast.kind === 'warning' ? 'assertive' : 'polite';

  return (
    <div
      role={live === 'assertive' ? 'alert' : 'status'}
      aria-live={live}
      className={cn('toast-card', toast.leaving && 'toast-card--out')}
    >
      <span className={cn('toast-card__icon', cfg.well)}>
        <Icon className={cn('h-3.5 w-3.5', cfg.glyph)} aria-hidden={true} />
      </span>

      <p className="min-w-0 flex-1 text-sm font-medium leading-snug text-content-primary">
        {toast.message}
      </p>

      <button
        type="button"
        onClick={() => dismiss(toast.id)}
        className="toast-dismiss-btn flex-none rounded-full text-content-muted hover:text-content-primary hover:bg-surface-subtle transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
        aria-label="Dismiss notification"
      >
        <X className="h-3.5 w-3.5" aria-hidden="true" strokeWidth={2} />
      </button>
    </div>
  );
};

export const Toast: React.FC = () => {
  const { toasts } = useToastStore();
  if (toasts.length === 0) return null;

  return (
    <div aria-label="Notifications" className="toast-region">
      {toasts.map((toast) => (
        <ToastEntry key={toast.id} toast={toast} />
      ))}
    </div>
  );
};
