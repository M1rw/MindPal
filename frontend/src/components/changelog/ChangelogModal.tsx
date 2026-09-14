import React, { useEffect, useState } from 'react';
import { useChangelogStore, useToastStore } from '../../store';
import { STORAGE_KEYS } from '../../constants/storage';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { ApiClient } from '../../services/api/index';
import { ChangelogHero } from './ChangelogHero';
import { ChangelogHighlights } from './ChangelogHighlights';

export const ChangelogModal: React.FC = () => {
  const { isOpen, setIsOpen, changelog } = useChangelogStore();
  const { push: pushToast } = useToastStore();
  const modalContentRef = useFocusTrap<HTMLDivElement>({
    isOpen,
    onClose: () => setIsOpen(false),
    autoFocus: true,
  });
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
      localStorage.setItem(STORAGE_KEYS.LAST_SEEN_CHANGELOG, currentVersion);
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
        ref={modalContentRef}
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
        <ChangelogHero
          currentVersion={currentVersion}
          title={entry?.title ?? "What's New in MindPal"}
          onClose={handleDismiss}
        />

        {/* Body */}
        <div className="flex-1 overflow-y-auto px-5 pt-4 pb-2 space-y-3 custom-scrollbar">
          {entry?.summary && (
            <p className="text-[13px] leading-relaxed text-zinc-400 font-normal">
              {entry.summary}
            </p>
          )}

          {entry?.highlights && entry.highlights.length > 0 && (
            <ChangelogHighlights highlights={entry.highlights} />
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
