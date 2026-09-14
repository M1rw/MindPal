import React, { Suspense } from 'react';
import { ChatCanvas } from '../chat/canvas/ChatCanvas';
import { ChatInput, type ChatInputHandle } from '../chat/input/ChatInput';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import type { AppTab } from '../ui/TabBar';
import { useFlagsStore } from '../../store';

const LazyPresenceShell = React.lazy(() =>
  import('../presence/PresenceShell').then((module) => ({ default: module.PresenceShell }))
);

interface AppPanelsProps {
  activeTab: AppTab;
  hasMessages: boolean;
  onSelectMood: (text: string) => void;
  chatInputRef: React.RefObject<ChatInputHandle | null>;
}

export const AppPanels: React.FC<AppPanelsProps> = ({
  activeTab,
  hasMessages,
  onSelectMood,
  chatInputRef,
}) => {
  const { flags } = useFlagsStore();
  const showPresence = Boolean(flags.presence_enabled ?? false);

  return (
    <main id="chat-main" role="main" className="flex-1 flex overflow-hidden relative">
      <div
        id="tabpanel-chat"
        role="tabpanel"
        aria-labelledby="tab-chat"
        className={[
          'absolute inset-0 flex flex-col transition-all duration-220 ease-out',
          activeTab === 'chat'
            ? 'opacity-100 scale-100 pointer-events-auto'
            : 'opacity-0 scale-[0.98] pointer-events-none',
        ].join(' ')}
        style={{ transitionTimingFunction: 'cubic-bezier(0.4,0,0.2,1)' }}
      >
        <div className="flex-1 flex flex-col overflow-hidden">
          <ErrorBoundary
            fallbackTitle="Chat Canvas Error"
            fallbackMessage="Could not display chat messages safely. Your data is preserved."
          >
            <ChatCanvas onSelectMood={onSelectMood}>
              {!hasMessages && <ChatInput ref={chatInputRef} />}
            </ChatCanvas>
          </ErrorBoundary>
        </div>

        <div
          className={[
            'flex-shrink-0 transition-all duration-350 ease-out',
            hasMessages
              ? 'opacity-100 translate-y-0'
              : 'opacity-0 pointer-events-none translate-y-3 h-0 overflow-hidden',
          ].join(' ')}
          style={{ transitionTimingFunction: 'cubic-bezier(0.4,0,0.2,1)' }}
        >
          {hasMessages && <ChatInput ref={chatInputRef} />}
        </div>
      </div>

      {showPresence && (
        <div
          id="tabpanel-presence"
          role="tabpanel"
          aria-labelledby="tab-presence"
          className={[
            'absolute inset-0 flex transition-all duration-250 ease-out overflow-y-auto',
            activeTab === 'presence'
              ? 'opacity-100 scale-100 pointer-events-auto'
              : 'opacity-0 scale-[0.98] pointer-events-none',
          ].join(' ')}
          style={{ transitionTimingFunction: 'cubic-bezier(0.4,0,0.2,1)' }}
        >
          <ErrorBoundary fallbackTitle="Presence View Error" fallbackMessage="Unable to load Presence features.">
            <Suspense fallback={<div className="w-full h-full animate-pulse bg-transparent" />}>
              <LazyPresenceShell />
            </Suspense>
          </ErrorBoundary>
        </div>
      )}
    </main>
  );
};
