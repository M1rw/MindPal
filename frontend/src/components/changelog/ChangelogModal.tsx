import React, { useEffect, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { useChangelogStore, useToastStore } from '../../store';
import { ApiClient } from '../../services/api';

// Hero gradient — atmospheric dark landscape feel
const HERO_GRADIENT = `
  radial-gradient(ellipse at 60% 0%, #6572F2 0%, transparent 55%),
  radial-gradient(ellipse at 20% 80%, #A39CF9 0%, transparent 50%),
  linear-gradient(160deg, #1a1040 0%, #0d0d1a 60%, #121218 100%)
`;

export const ChangelogModal: React.FC = () => {
  const { isOpen, setIsOpen, changelog } = useChangelogStore();
  const { push: pushToast } = useToastStore();
  const [visible, setVisible] = useState(false);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setMounted(true);
      requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
    } else {
      setVisible(false);
      const t = setTimeout(() => setMounted(false), 320);
      return () => clearTimeout(t);
    }
  }, [isOpen]);

  if (!mounted || !changelog) return null;

  const currentVersion = changelog.current_version || '5.0.0';
  const entry = changelog.entries?.find((e) => e.version === currentVersion) ?? changelog.entries?.[0];

  const handleDismiss = async () => {
    try {
      localStorage.setItem('mindpal_last_seen_changelog', currentVersion);
      await ApiClient.dismissChangelog(currentVersion);
    } catch { /* offline graceful */ }
    setIsOpen(false);
    pushToast(`Welcome to MindPal ${currentVersion}! ✨`, 'success');
  };

  return (
    <div
      id="changelog-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="changelog-title"
      onClick={handleDismiss}
      className={[
        'fixed inset-0 z-[90] flex items-end sm:items-center justify-center p-4 sm:p-6',
        'transition-all duration-300 ease-out',
        visible ? 'bg-black/60 backdrop-blur-md' : 'bg-transparent backdrop-blur-none',
      ].join(' ')}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className={[
          'w-full max-w-[360px] rounded-[28px] overflow-hidden shadow-2xl flex flex-col',
          'bg-[#111118] text-white',
          'transition-all duration-320 ease-out',
          visible
            ? 'opacity-100 translate-y-0 scale-100'
            : 'opacity-0 translate-y-6 scale-[0.95]',
        ].join(' ')}
        style={{ maxHeight: '92dvh' }}
      >
        {/* Hero Section */}
        <div
          className="relative h-[180px] flex-shrink-0 overflow-hidden"
          style={{ background: HERO_GRADIENT }}
        >
          {/* Floating orbs */}
          <div className="absolute inset-0 overflow-hidden">
            <div className="absolute -top-8 -right-8 w-40 h-40 rounded-full bg-[#6572F2]/30 blur-3xl" />
            <div className="absolute bottom-0 left-4 w-32 h-32 rounded-full bg-[#A39CF9]/20 blur-2xl" />
            <div className="absolute top-6 left-1/2 -translate-x-1/2 w-24 h-24 rounded-full bg-white/5 blur-xl" />
          </div>

          {/* Version chip */}
          <div className="absolute top-4 left-5 flex items-center gap-2">
            <span className="px-2.5 py-1 rounded-full text-[10px] font-bold bg-white/15 text-white uppercase tracking-widest backdrop-blur-sm border border-white/20">
              v{currentVersion} · Major Release
            </span>
          </div>

          {/* Close */}
          <button
            type="button"
            onClick={handleDismiss}
            className="absolute top-4 right-4 w-8 h-8 rounded-full bg-black/30 hover:bg-black/50 flex items-center justify-center text-white/70 hover:text-white transition-colors backdrop-blur-sm"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>

          {/* Hero Text */}
          <div className="absolute bottom-5 left-5 right-5">
            <h2
              id="changelog-title"
              className="text-[22px] font-bold leading-tight text-white"
            >
              {entry?.title ?? "What's New in MindPal"}
            </h2>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 pt-4 pb-2 space-y-3 custom-scrollbar">
          {entry?.summary && (
            <p className="text-[13px] leading-relaxed text-zinc-400 font-normal">
              {entry.summary}
            </p>
          )}

          {/* What You'll Get */}
          {entry?.highlights && entry.highlights.length > 0 && (
            <div className="space-y-1 pt-1">
              <div className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500 mb-2">
                What&apos;s New
              </div>
              {entry.highlights.map((h, i) => {
                // Split on first ' — ' into title + desc if present
                const dashIdx = h.indexOf(' — ');
                const title = dashIdx > 0 ? h.slice(0, dashIdx) : h;
                const desc = dashIdx > 0 ? h.slice(dashIdx + 3) : null;

                return (
                  <div key={i} className="flex items-start gap-3 py-2">
                    <div className="w-5 h-5 rounded-full bg-white/10 flex items-center justify-center flex-shrink-0 mt-0.5 border border-white/15">
                      <Check className="w-3 h-3 text-white stroke-[2.5]" />
                    </div>
                    <div>
                      <div className="text-[13px] font-semibold text-white leading-snug">{title}</div>
                      {desc && (
                        <div className="text-[12px] text-zinc-500 leading-relaxed mt-0.5">{desc}</div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer Buttons */}
        <div className="px-5 py-4 flex items-center gap-2 flex-shrink-0 border-t border-white/[0.06]">
          <button
            type="button"
            onClick={handleDismiss}
            className="flex-1 h-11 rounded-full bg-white/10 hover:bg-white/15 text-white/80 hover:text-white text-[14px] font-medium transition-colors"
          >
            Close
          </button>
          <button
            type="button"
            onClick={handleDismiss}
            className="flex-1 h-11 rounded-full bg-white hover:bg-zinc-100 text-zinc-900 text-[14px] font-semibold transition-colors shadow-lg"
          >
            Explore MindPal
          </button>
        </div>
      </div>
    </div>
  );
};
