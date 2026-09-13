import React, { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useToastStore } from '../../store';
import type { ToastItem } from '../../types';

const ICON_MAP: Record<string, string> = {
  success: '✓',
  error: '✕',
  warning: '⚠',
  info: 'ℹ',
};

const COLOR_MAP: Record<string, string> = {
  success: 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800/60 text-emerald-800 dark:text-emerald-200',
  error: 'bg-red-50 dark:bg-red-950/40 border-red-200 dark:border-red-800/60 text-red-800 dark:text-red-200',
  warning: 'bg-amber-50 dark:bg-amber-950/40 border-amber-200 dark:border-amber-800/60 text-amber-800 dark:text-amber-200',
  info: 'bg-white dark:bg-gemini-darkSurface border-gemini-border dark:border-gemini-darkBorder text-gemini-text dark:text-gemini-darkText',
};

const ToastEntry: React.FC<{ toast: ToastItem }> = ({ toast }) => {
  const { dismiss } = useToastStore();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Trigger enter animation
    const el = ref.current;
    if (!el) return;
    el.style.opacity = '0';
    el.style.transform = 'translateY(12px)';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!el) return;
        el.style.transition = 'opacity 250ms ease-out, transform 250ms ease-out';
        el.style.opacity = '1';
        el.style.transform = 'translateY(0)';
      });
    });
  }, []);

  return (
    <div
      ref={ref}
      role="alert"
      aria-live="assertive"
      className={`flex items-start gap-3 w-full max-w-sm px-4 py-3 rounded-2xl border shadow-lg text-sm ${COLOR_MAP[toast.kind]}`}
    >
      <span className="font-bold text-base leading-none mt-0.5 shrink-0" aria-hidden="true">
        {ICON_MAP[toast.kind]}
      </span>
      <span className="flex-1 leading-snug">{toast.message}</span>
      <button
        onClick={() => dismiss(toast.id)}
        className="shrink-0 p-1 rounded-full hover:bg-black/10 dark:hover:bg-white/10 transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
        aria-label="Dismiss notification"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
};

export const Toast: React.FC = () => {
  const { toasts } = useToastStore();

  return (
    <div
      aria-label="Notifications"
      className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[200] flex flex-col items-center gap-2 w-full px-4 pointer-events-none"
    >
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto w-full max-w-sm">
          <ToastEntry toast={t} />
        </div>
      ))}
    </div>
  );
};
