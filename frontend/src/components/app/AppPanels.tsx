import React, { Suspense, useEffect, useRef } from 'react';
import { ChatCanvas } from '../chat/canvas/ChatCanvas';
import { ChatInput, type ChatInputHandle } from '../chat/input/ChatInput';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import type { AppTab } from '../ui/TabBar';
import { useChatStore, useFlagsStore } from '../../store';

const LazyPresenceShell = React.lazy(() =>
  import('../presence/PresenceShell').then((module) => ({ default: module.PresenceShell }))
);

interface AppPanelsProps {
  activeTab: AppTab;
  onSelectMood: (text: string) => void;
  chatInputRef: React.RefObject<ChatInputHandle | null>;
}

export const AppPanels: React.FC<AppPanelsProps> = ({
  activeTab,
  onSelectMood,
  chatInputRef,
}) => {
  const { flags } = useFlagsStore();
  const showPresence = Boolean(flags.presence_enabled ?? false);
  const hasMessages = useChatStore((state) => state.messages.length > 0);
  const [composerHeight, setComposerHeight] = React.useState(0);
  const composerWrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = composerWrapRef.current;
    if (!element) return;
    const updateHeight = () => setComposerHeight(element.getBoundingClientRect().height);
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const chatShell = (
    <div
      className={`chat-stage ${hasMessages ? 'chat-stage--thread' : 'chat-stage--empty'}`}
      style={{ '--composer-dock-height': `${composerHeight}px` } as React.CSSProperties}
    >
      <div className="chat-stage__canvas">
        <ErrorBoundary
          fallbackTitle="Chat Canvas Error"
          fallbackMessage="Could not display chat messages safely. Your data is preserved."
        >
          <ChatCanvas onSelectMood={onSelectMood} />
        </ErrorBoundary>
      </div>

      <div ref={composerWrapRef} className="chat-composer-dock">
        <ChatInput ref={chatInputRef} />
      </div>
      <div aria-hidden="true" />
    </div>
  );

  if (!showPresence) {
    return (
      <main id="chat-main" role="main" className="flex-1 flex flex-col overflow-hidden relative">
        {chatShell}
      </main>
    );
  }

  return (
    <main id="chat-main" role="main" className="flex-1 flex overflow-hidden relative">
      <div
        id="tabpanel-chat"
        role="tabpanel"
        aria-labelledby="tab-chat"
        aria-hidden={activeTab !== 'chat'}
        className={[
          'absolute inset-0 flex flex-col transition-opacity duration-200 ease-out',
          activeTab === 'chat'
            ? 'opacity-100 pointer-events-auto'
            : 'opacity-0 pointer-events-none',
        ].join(' ')}
      >
        {chatShell}
      </div>

      {showPresence && (
        <div
          id="tabpanel-presence"
          role="tabpanel"
          aria-labelledby="tab-presence"
          aria-hidden={activeTab !== 'presence'}
          className={[
            'absolute inset-0 flex transition-opacity duration-200 ease-out overflow-y-auto',
            activeTab === 'presence'
              ? 'opacity-100 pointer-events-auto'
              : 'opacity-0 pointer-events-none',
          ].join(' ')}
        >
          <ErrorBoundary fallbackTitle="Presence View Error" fallbackMessage="Unable to load Presence features.">
            <Suspense fallback={<div className="w-full h-full bg-transparent" />}>
              <LazyPresenceShell />
            </Suspense>
          </ErrorBoundary>
        </div>
      )}
    </main>
  );
};
