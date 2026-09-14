import React, { useState } from 'react';
import { useToastStore } from '../../store';
import { STORAGE_KEYS } from '../../constants/storage';
import {
  PresenceAccessPanel,
  PresenceFeatureCard,
  PresenceHeader,
  PresenceModeSwitcher,
  PresenceTrustGrid,
  type PresenceMode,
} from './parts';

export const PresenceShell: React.FC = () => {
  const [activeMode, setActiveMode] = useState<PresenceMode>('solo');
  const [hasRequestedAccess, setHasRequestedAccess] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEYS.PRESENCE_WAITLIST) === 'true';
    } catch {
      return false;
    }
  });

  const { push: pushToast } = useToastStore();

  const handleRequestAccess = () => {
    try {
      localStorage.setItem(STORAGE_KEYS.PRESENCE_WAITLIST, 'true');
    } catch {
      // ignore
    }
    setHasRequestedAccess(true);
    pushToast('Access requested! You are in the priority clinical alpha cohort.', 'info');
  };

  return (
    <div
      id="tabpanel-presence"
      role="tabpanel"
      aria-labelledby="tab-presence"
      className="flex-1 overflow-y-auto px-4 py-8 sm:py-12 max-w-4xl mx-auto w-full text-center custom-scrollbar animate-fade-in flex flex-col items-center justify-center min-h-full"
    >
      <div className="relative w-full max-w-3xl flex flex-col items-center">
        <div className="absolute -top-12 inset-x-0 h-72 bg-gradient-to-tr from-[#4140FD]/20 via-[#8B5CF6]/15 to-[#06B6D4]/10 rounded-full blur-3xl pointer-events-none -z-10" />

        <PresenceHeader />

        <PresenceModeSwitcher activeMode={activeMode} onChangeMode={setActiveMode} />

        <div className="w-full bg-[#f0f4f9] dark:bg-gemini-darkSurface rounded-[28px] p-6 sm:p-8 text-left shadow-sm mb-8 transition-all relative overflow-hidden">
          <div className="absolute top-0 right-0 w-64 h-64 bg-[#4140FD]/10 rounded-full blur-3xl pointer-events-none" />
          <PresenceFeatureCard mode={activeMode} />
        </div>

        <PresenceAccessPanel
          hasRequestedAccess={hasRequestedAccess}
          onRequestAccess={handleRequestAccess}
        />

        <PresenceTrustGrid />
      </div>
    </div>
  );
};
