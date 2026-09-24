import React, { Suspense } from 'react';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { Toast } from '../ui/Toast';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { useFlagsStore, useVoiceStore } from '../../store';

const LazyMemoryInspector = React.lazy(() =>
  import('../memory/MemoryInspector').then((module) => ({ default: module.MemoryInspector }))
);
const LazySettingsModal = React.lazy(() =>
  import('../settings/SettingsModal').then((module) => ({ default: module.SettingsModal }))
);
const LazyStreakModal = React.lazy(() =>
  import('../streak/StreakModal').then((module) => ({ default: module.StreakModal }))
);
const LazyAuthModal = React.lazy(() =>
  import('../auth/AuthModal').then((module) => ({ default: module.AuthModal }))
);
const LazyChangelogModal = React.lazy(() =>
  import('../changelog/ChangelogModal').then((module) => ({ default: module.ChangelogModal }))
);
const LazyChatHistoryModal = React.lazy(() =>
  import('../chat/history/ChatHistoryModal').then((module) => ({ default: module.ChatHistoryModal }))
);
const LazyVoiceOverlay = React.lazy(() =>
  import('../voice/VoiceOverlay').then((module) => ({ default: module.VoiceOverlay }))
);

interface AppModalsProps {
  memoryOpen: boolean;
  onOpenMemory: () => void;
  onCloseMemory: () => void;
}

export const AppModals: React.FC<AppModalsProps> = ({
  memoryOpen,
  onOpenMemory,
  onCloseMemory,
}) => {
  const liveEnabled = useFlagsStore((state) => state.flags.voice_enabled);
  const voiceActive = useVoiceStore((state) => state.isActive);
  const showLiveVoice = Boolean(liveEnabled && voiceActive);

  return (
    <>
      <ErrorBoundary variant="modal">
        <Suspense fallback={null}>
          <LazySettingsModal onOpenMemory={onOpenMemory} />
        </Suspense>
      </ErrorBoundary>
      <ErrorBoundary variant="modal">
        <Suspense fallback={null}>
          <LazyMemoryInspector isOpen={memoryOpen} onClose={onCloseMemory} />
        </Suspense>
      </ErrorBoundary>
      <ErrorBoundary variant="modal">
        <Suspense fallback={null}>
          <LazyStreakModal />
        </Suspense>
      </ErrorBoundary>
      <ErrorBoundary variant="modal">
        <Suspense fallback={null}>
          <LazyAuthModal />
        </Suspense>
      </ErrorBoundary>
      <ErrorBoundary variant="modal">
        <Suspense fallback={null}>
          <LazyChangelogModal />
        </Suspense>
      </ErrorBoundary>
      <ErrorBoundary variant="modal">
        <Suspense fallback={null}>
          <LazyChatHistoryModal />
        </Suspense>
      </ErrorBoundary>
      {showLiveVoice ? (
        <ErrorBoundary variant="modal">
          <Suspense fallback={null}>
            <LazyVoiceOverlay />
          </Suspense>
        </ErrorBoundary>
      ) : null}
      <ConfirmDialog />
      <Toast />
    </>
  );
};
