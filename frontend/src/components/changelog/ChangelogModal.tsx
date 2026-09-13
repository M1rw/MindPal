import React from 'react';
import { Sparkles, X, Check, ArrowRight, ShieldCheck, Zap } from 'lucide-react';
import { useChangelogStore, useToastStore } from '../../store';
import { ApiClient } from '../../services/api';

export const ChangelogModal: React.FC = () => {
  const { isOpen, setIsOpen, changelog } = useChangelogStore();
  const { push: pushToast } = useToastStore();

  if (!isOpen || !changelog) return null;

  const currentVersion = changelog.current_version || '5.0.0';
  const majorEntry = changelog.entries?.find((e) => e.version === currentVersion) || changelog.entries?.[0];

  const handleDismiss = async () => {
    try {
      localStorage.setItem('mindpal_last_seen_changelog', currentVersion);
      await ApiClient.dismissChangelog(currentVersion);
    } catch {
      // Graceful offline fallback
    }
    setIsOpen(false);
    pushToast('Welcome to MindPal 5.0!', 'info');
  };

  return (
    <div
      id="changelog-modal"
      className="fixed inset-0 z-[90] flex items-center justify-center p-4 bg-black/60 backdrop-blur-md animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="changelog-title"
      onClick={handleDismiss}
    >
      <div
        className="bg-white dark:bg-[#16161E] w-full max-w-lg rounded-[28px] shadow-2xl overflow-hidden border border-black/[0.08] dark:border-white/[0.12] flex flex-col max-h-[85vh] transition-all transform animate-fade-in relative"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Subtle Ambient Top Glow */}
        <div className="absolute top-0 inset-x-0 h-28 bg-gradient-to-b from-[#4140FD]/15 via-[#6572F2]/5 to-transparent pointer-events-none" />

        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 pt-6 pb-4 border-b border-black/[0.06] dark:border-white/[0.08] relative z-10">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-[#4140FD]/10 dark:bg-[#6572F2]/20 flex items-center justify-center text-[#4140FD] dark:text-[#A39CF9]">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-[#4140FD]/10 dark:bg-[#6572F2]/20 text-[#4140FD] dark:text-[#A39CF9] uppercase tracking-wider">
                  Major Release
                </span>
                <span className="text-xs font-semibold text-zinc-400 dark:text-zinc-500">
                  v{currentVersion}
                </span>
              </div>
              <h2
                id="changelog-title"
                className="text-base font-semibold text-zinc-900 dark:text-zinc-100 mt-0.5"
              >
                {majorEntry?.title || "What's New in MindPal"}
              </h2>
            </div>
          </div>

          <button
            type="button"
            onClick={handleDismiss}
            className="w-8 h-8 rounded-full flex items-center justify-center text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
            aria-label="Close changelog"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Body */}
        <div className="px-6 py-5 overflow-y-auto custom-scrollbar space-y-4 text-xs text-zinc-700 dark:text-zinc-300 relative z-10">
          {majorEntry?.summary && (
            <p className="text-[13px] leading-relaxed text-zinc-600 dark:text-zinc-300 font-medium">
              {majorEntry.summary}
            </p>
          )}

          {/* Feature Highlights */}
          <div className="space-y-2.5 pt-1">
            <div className="text-[11px] font-bold uppercase tracking-wider text-zinc-400 dark:text-zinc-500">
              Key Capabilities
            </div>

            {majorEntry?.highlights?.map((highlight, index) => (
              <div
                key={index}
                className="flex items-start gap-3 p-3 rounded-2xl bg-black/[0.02] dark:bg-white/[0.03] border border-black/[0.04] dark:border-white/[0.06] transition-colors"
              >
                <div className="w-5 h-5 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 flex items-center justify-center flex-shrink-0 mt-0.5">
                  <Check className="w-3 h-3 stroke-[2.5]" />
                </div>
                <div className="text-xs leading-relaxed text-zinc-700 dark:text-zinc-200 font-medium">
                  {highlight}
                </div>
              </div>
            ))}
          </div>

          {/* Security & Privacy Banner */}
          <div className="flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl bg-emerald-50/50 dark:bg-emerald-950/20 text-emerald-800 dark:text-emerald-300 border border-emerald-500/20">
            <ShieldCheck className="w-4 h-4 flex-shrink-0" />
            <span className="text-[11px] font-medium">
              Strict clinical safety protocols & in-memory zero-transit privacy.
            </span>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-black/[0.06] dark:border-white/[0.08] bg-zinc-50/70 dark:bg-[#121218]/70 flex items-center justify-between gap-3 relative z-10">
          <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
            MindPal 5.0 Clinical Suite
          </span>

          <button
            type="button"
            onClick={handleDismiss}
            className="px-5 py-2.5 rounded-xl bg-[#4140FD] hover:bg-[#3231d6] text-white text-xs font-semibold shadow-md active:scale-95 transition-all flex items-center gap-1.5"
          >
            <span>Explore MindPal</span>
            <ArrowRight className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
};
