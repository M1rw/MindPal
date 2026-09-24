import React, { useState, useRef } from 'react';
import { Header } from './components/ui/Header';
import { type AppTab } from './components/ui/TabBar';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { AppPanels } from './components/app/AppPanels';
import { AppModals } from './components/app/AppModals';
import { ChatInputHandle } from './components/chat/input/ChatInput';
import { useFlagsStore, useMemoryStore } from './store/index';
import { useAppBootstrap } from './hooks/session/useAppBootstrap';
import { useChatSessionPersistence } from './hooks/chat/useChatSessionPersistence';
import { useGlobalShortcuts } from './hooks/ui/useGlobalShortcuts';

export const App: React.FC = () => {
  const memoryOpen = useMemoryStore((state) => state.isOpen);
  const setMemoryOpen = useMemoryStore((state) => state.setIsOpen);
  const [activeTab, setActiveTab] = useState<AppTab>('chat');
  const chatInputRef = useRef<ChatInputHandle>(null);

  useAppBootstrap();
  const { flags } = useFlagsStore();
  const showPresenceTab = Boolean(flags.presence_enabled ?? false);
  const resolvedActiveTab = showPresenceTab ? activeTab : 'chat';
  useChatSessionPersistence();
  useGlobalShortcuts();

  return (
    <ErrorBoundary variant="app">
      <div className="app-shell h-dvh-safe flex flex-col bg-surface-canvas text-content-primary font-sans overflow-hidden transition-colors duration-200 ease-out selection:bg-brand-primary selection:text-white">
        <a
          href="#chat-main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 z-[9999] px-4 py-2.5 bg-brand-primary text-white font-medium text-sm rounded-xl shadow-xl outline-none ring-2 ring-white focus:outline-none"
        >
          Skip to main content
        </a>

        <Header
          activeTab={resolvedActiveTab}
          onTabChange={setActiveTab}
          showPresenceTab={showPresenceTab}
        />

        <AppPanels
          activeTab={resolvedActiveTab}
          onSelectMood={(moodText) => chatInputRef.current?.sendMessage(moodText)}
          chatInputRef={chatInputRef}
        />

        <AppModals
          memoryOpen={memoryOpen}
          onOpenMemory={() => setMemoryOpen(true)}
          onCloseMemory={() => setMemoryOpen(false)}
        />
      </div>
    </ErrorBoundary>
  );
};
