import React, { Suspense, useLayoutEffect, useRef } from 'react';
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
  const composerWrapRef = useRef<HTMLDivElement>(null);
  const composerRectRef = useRef<DOMRect | null>(null);

  useLayoutEffect(() => {
    const el = composerWrapRef.current;
    if (!el) return;

    // Fix 11: Publish --composer-dock-h on :root so .chat-jump-latest and
    // .toast-region can position themselves above the composer automatically.
    const publishHeight = () => {
      const h = el.getBoundingClientRect().height;
      document.documentElement.style.setProperty('--composer-dock-h', `${h}px`);
    };
    publishHeight();
    const ro = new ResizeObserver(publishHeight);
    ro.observe(el);

    return () => ro.disconnect();
  }, []);

  useLayoutEffect(() => {
    const el = composerWrapRef.current;
    if (!el) return;
    if (el.getAnimations().some((animation) => animation.playState !== 'finished')) {
      return;
    }

    const next = el.getBoundingClientRect();
    const prev = composerRectRef.current;
    composerRectRef.current = next;
    if (!prev) return;

    const dy = prev.top - next.top;
    if (Math.abs(dy) < 8) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const animation = el.animate(
      [
        { transform: `translateY(${dy}px)` },
        { transform: 'translateY(0px)' },
      ],
      { duration: 420, easing: 'cubic-bezier(0.16, 1, 0.3, 1)', fill: 'none' }
    );
    animation.onfinish = () => {
      composerRectRef.current = el.getBoundingClientRect();
    };
  }, [hasMessages]);

  const chatShell = (
    <div className={`chat-stage ${hasMessages ? 'chat-stage--thread' : ''}`}>
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
