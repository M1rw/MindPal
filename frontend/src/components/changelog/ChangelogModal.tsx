import React from 'react';
import { useAuthStore, useChangelogStore, useToastStore } from '../../store';
import { STORAGE_KEYS } from '../../constants/storage';
import { ApiClient } from '../../services/api/index';
import { ChangelogHero } from './ChangelogHero';
import { ChangelogHighlights } from './ChangelogHighlights';
import { Modal, ModalBody, ModalFooter } from '../ui/Modal';
import { useIsSignedIn } from '../../hooks/session/useAccountStatus.ts';

export const ChangelogModal: React.FC = () => {
  const { isOpen, setIsOpen, changelog } = useChangelogStore();
  const { push: pushToast } = useToastStore();
  const accountId = useAuthStore((state) => state.user?.uid ?? null);
  const isAuthenticated = useIsSignedIn();

  const currentVersion = changelog?.current_version || '5.0.5';
  const entry = changelog?.entries?.find((e) => e.version === currentVersion) ?? changelog?.entries?.[0];

  const handleDismiss = async () => {
    setIsOpen(false);
    try {
      if (isAuthenticated && accountId) {
        await ApiClient.dismissChangelog(currentVersion);
      } else {
        localStorage.setItem(STORAGE_KEYS.LAST_SEEN_CHANGELOG, currentVersion);
      }
    } catch (error) {
      console.warn('Failed to persist changelog dismissal:', error);
    }
    pushToast(`Welcome to MindPal ${currentVersion}.`, 'success');
  };

  return (
    <Modal
      id="changelog-modal"
      open={Boolean(isOpen && changelog)}
      onClose={handleDismiss}
      labelledBy="changelog-title"
      size="lg"
      layer={90}
      flush
      panelClassName="max-h-[min(52rem,96dvh)] max-w-lg"
    >
      <ChangelogHero
        currentVersion={currentVersion}
        title={entry?.title ?? "What's new in MindPal"}
        major={Boolean(entry?.major)}
        onClose={handleDismiss}
      />

      <ModalBody className="px-6 pt-6 pb-4 space-y-5 custom-scrollbar">
        {entry?.summary ? (
          <p className="text-sm leading-relaxed text-content-secondary">
            {entry.summary}
          </p>
        ) : null}

        {entry?.highlights && entry.highlights.length > 0 ? (
          <ChangelogHighlights highlights={entry.highlights} />
        ) : null}
      </ModalBody>

      <ModalFooter>
        <button
          type="button"
          onClick={handleDismiss}
          className="flex-1 h-12 rounded-full bg-surface-subtle hover:bg-surface-elevated text-content-secondary hover:text-content-primary text-sm font-medium border border-edge-subtle transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
        >
          Close
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          className="flex-1 h-12 rounded-full bg-brand-primary hover:bg-brand-hover text-white text-sm font-semibold transition-colors duration-150 ease-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface-card"
        >
          Continue
        </button>
      </ModalFooter>
    </Modal>
  );
};
