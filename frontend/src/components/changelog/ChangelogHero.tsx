import React from 'react';
import { X } from 'lucide-react';

interface ChangelogHeroProps {
  currentVersion: string;
  title: string;
  onClose: () => void;
}

const HERO_GRADIENT = `
  radial-gradient(ellipse at 60% 0%, #6572F2 0%, transparent 55%),
  radial-gradient(ellipse at 20% 80%, #A39CF9 0%, transparent 50%),
  linear-gradient(160deg, #1a1040 0%, #0d0d1a 60%, #121218 100%)
`;

export const ChangelogHero: React.FC<ChangelogHeroProps> = ({
  currentVersion,
  title,
  onClose,
}) => (
  <div className="relative h-[180px] flex-shrink-0 overflow-hidden" style={{ background: HERO_GRADIENT }}>
    <div className="absolute inset-0 overflow-hidden">
      <div className="absolute -top-8 -right-8 w-40 h-40 rounded-full bg-[#6572F2]/30 blur-3xl" />
      <div className="absolute bottom-0 left-4 w-32 h-32 rounded-full bg-[#A39CF9]/20 blur-2xl" />
      <div className="absolute top-6 left-1/2 -translate-x-1/2 w-24 h-24 rounded-full bg-white/5 blur-xl" />
    </div>

    <div className="absolute top-4 left-5 flex items-center gap-2">
      <span className="px-2.5 py-1 rounded-full text-[10px] font-bold bg-white/15 text-white uppercase tracking-widest backdrop-blur-sm border border-white/20">
        v{currentVersion} · Major Release
      </span>
    </div>

    <button
      type="button"
      onClick={onClose}
      className="absolute top-4 right-4 w-8 h-8 rounded-full bg-black/30 hover:bg-black/50 flex items-center justify-center text-white/70 hover:text-white transition-colors backdrop-blur-sm"
      aria-label="Close"
    >
      <X className="w-4 h-4" />
    </button>

    <div className="absolute bottom-5 left-5 right-5">
      <h2 id="changelog-title" className="text-[22px] font-bold leading-tight text-white">
        {title}
      </h2>
    </div>
  </div>
);
