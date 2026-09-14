import React from 'react';
import { ArrowRight, Check } from 'lucide-react';

interface PresenceAccessPanelProps {
  hasRequestedAccess: boolean;
  onRequestAccess: () => void;
}

export const PresenceAccessPanel: React.FC<PresenceAccessPanelProps> = ({
  hasRequestedAccess,
  onRequestAccess,
}) => (
  <div className="w-full flex flex-col sm:flex-row items-center justify-between gap-4 p-5 rounded-2xl bg-white/80 dark:bg-zinc-900/80 border border-black/[0.06] dark:border-white/[0.08] shadow-sm mb-8">
    <div className="text-left">
      <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100 flex items-center gap-1.5">
        <span>Priority Alpha Cohort</span>
      </div>
      <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
        Limited rollout for clinicians, couples, and research testbeds.
      </div>
    </div>

    <button
      type="button"
      onClick={onRequestAccess}
      disabled={hasRequestedAccess}
      className={`px-5 py-2.5 rounded-xl text-xs font-semibold flex items-center gap-2 transition-all active:scale-95 shadow-sm ${
        hasRequestedAccess
          ? 'bg-emerald-500 text-white cursor-default'
          : 'bg-[#4140FD] hover:bg-[#3231d6] text-white'
      }`}
    >
      {hasRequestedAccess ? (
        <>
          <Check className="w-4 h-4 stroke-[2.5]" />
          <span>Spot Reserved · Priority Cohort</span>
        </>
      ) : (
        <>
          <span>Request Private Alpha Access</span>
          <ArrowRight className="w-3.5 h-3.5" />
        </>
      )}
    </button>
  </div>
);
