import React from 'react';
import { ModalClose } from '../ui/Modal';

interface ChangelogHeroProps {
  currentVersion: string;
  title: string;
  major?: boolean;
  onClose: () => void;
}

const HERO_GRADIENT = `
  radial-gradient(ellipse at 70% 0%, rgba(101, 114, 242, 0.55) 0%, transparent 58%),
  radial-gradient(ellipse at 12% 90%, rgba(163, 156, 249, 0.35) 0%, transparent 52%),
  linear-gradient(165deg, #1a1040 0%, #12121c 62%, #16161f 100%)
`;

export const ChangelogHero: React.FC<ChangelogHeroProps> = ({
  currentVersion,
  title,
  major = false,
  onClose,
}) => (
  <div className="relative h-56 flex-none overflow-hidden" style={{ background: HERO_GRADIENT }}>
    <div className="absolute inset-0 overflow-hidden pointer-events-none" aria-hidden="true">
      <div className="absolute -top-10 -right-10 w-48 h-48 rounded-full bg-brand-secondary/30 blur-3xl" />
      <div className="absolute -bottom-6 left-6 w-40 h-40 rounded-full bg-brand-accent/20 blur-2xl" />
    </div>

    <div className="absolute top-5 left-6 right-16">
      <span className="inline-flex items-center px-3 py-1.5 rounded-full text-2xs font-semibold uppercase tracking-widest bg-white/15 text-white border border-white/20 backdrop-blur-sm">
        v{currentVersion}
        {major ? ' · Major release' : ''}
      </span>
    </div>

    <ModalClose onClick={onClose} label="Close release notes" tone="inverse" />

    <div className="absolute bottom-6 left-6 right-6">
      <p className="text-2xs font-semibold uppercase tracking-widest text-white/55 mb-2">
        What&apos;s new
      </p>
      <h2 id="changelog-title" className="text-2xl font-semibold tracking-tight text-white leading-snug">
        {title}
      </h2>
    </div>
  </div>
);
