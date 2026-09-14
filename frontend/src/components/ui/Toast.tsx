import React, { useEffect, useRef } from 'react';
import { CheckCircle2, XCircle, AlertTriangle, Info, X } from 'lucide-react';
import { useToastStore } from '../../store';
import type { ToastItem } from '../../types';

type ToastConfig = {
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  bar: string;
  bg: string;
  text: string;
};

const CONFIG: Record<string, ToastConfig> = {
  success: {
    icon: CheckCircle2,
    bar: 'bg-emerald-500',
    bg: 'bg-surface-card border border-edge-subtle specular-card',
    text: 'text-content-primary',
  },
  error: {
    icon: XCircle,
    bar: 'bg-rose-500',
    bg: 'bg-surface-card border border-edge-subtle specular-card',
    text: 'text-content-primary',
  },
  warning: {
    icon: AlertTriangle,
    bar: 'bg-amber-400',
    bg: 'bg-surface-card border border-edge-subtle specular-card',
    text: 'text-content-primary',
  },
  info: {
    icon: Info,
    bar: 'bg-brand-primary',
    bg: 'bg-surface-card border border-edge-subtle specular-card',
    text: 'text-content-primary',
  },
};

const ICON_COLOR: Record<string, string> = {
  success: 'text-emerald-500',
  error: 'text-rose-500',
  warning: 'text-amber-400',
  info: 'text-brand-primary',
};

const ToastEntry: React.FC<{ toast: ToastItem }> = ({ toast }) => {
  const { dismiss } = useToastStore();
  const ref = useRef<HTMLDivElement>(null);
  const cfg = CONFIG[toast.kind] ?? CONFIG.info;
  const Icon = cfg.icon;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Slide in from right
    el.style.opacity = '0';
    el.style.transform = 'translateX(24px)';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!el) return;
        el.style.transition = 'opacity 280ms cubic-bezier(0.16,1,0.3,1), transform 280ms cubic-bezier(0.16,1,0.3,1)';
        el.style.opacity = '1';
        el.style.transform = 'translateX(0)';
      });
    });
  }, []);

  return (
    <div
      ref={ref}
      role="alert"
      aria-live="assertive"
      className={`
        relative flex items-center gap-3 w-full max-w-[320px] pl-4 pr-3 py-3.5
        rounded-2xl shadow-xl overflow-hidden
        ${cfg.bg} ${cfg.text}
        border border-black/[0.07] dark:border-white/[0.08]
      `}
    >
      {/* Left color accent bar */}
      <div className={`absolute left-0 top-0 bottom-0 w-[3px] ${cfg.bar} rounded-l-2xl`} />

      <Icon className={`w-4 h-4 flex-shrink-0 ${ICON_COLOR[toast.kind]}`} aria-hidden={true} />

      <span className="flex-1 text-[13px] leading-snug font-medium">{toast.message}</span>

      <button
        onClick={() => dismiss(toast.id)}
        className="toast-dismiss-btn flex-shrink-0 w-6 h-6 flex items-center justify-center rounded-full text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
        aria-label="Dismiss"
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
      className="fixed top-5 right-5 z-[300] flex flex-col items-end gap-2 pointer-events-none"
    >
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto">
          <ToastEntry toast={t} />
        </div>
      ))}
    </div>
  );
};
