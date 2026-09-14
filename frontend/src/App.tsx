import React, { useState, useRef } from 'react';
import { Header } from './components/ui/Header';
import { TabBar, type AppTab } from './components/ui/TabBar';
import { GlobalLoader } from './components/ui/GlobalLoader';
import { ErrorBoundary } from './components/ui/ErrorBoundary';
import { AppPanels } from './components/app/AppPanels';
import { AppModals } from './components/app/AppModals';
import { ChatInputHandle } from './components/chat/input/ChatInput';
import { useChatStore, useFlagsStore } from './store/index';
import { useAppBootstrap } from './hooks/useAppBootstrap';
import { useChatSessionPersistence } from './hooks/useChatSessionPersistence';

export const App: React.FC = () => {
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<AppTab>('chat');
  const chatInputRef = useRef<ChatInputHandle>(null);

  const { appReady } = useAppBootstrap();
  const { messages } = useChatStore();
  const { flags } = useFlagsStore();
  const showPresenceTab = Boolean(flags.presence_enabled ?? false);
  const resolvedActiveTab = showPresenceTab ? activeTab : 'chat';
  useChatSessionPersistence();

  const hasMessages = messages.length > 0;

  return (
    <ErrorBoundary variant="app">
      <div className="h-dvh-safe flex flex-col bg-gemini-bg dark:bg-gemini-darkBg text-gemini-text dark:text-gemini-darkText font-sans overflow-hidden transition-colors duration-300 selection:bg-brand-primary selection:text-white relative">
        {/* Skip to Main Content Link for WCAG 2.1 keyboard users */}
        <a
          href="#chat-main"
          className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 z-[9999] px-4 py-2.5 bg-[#4140FD] text-white font-medium text-sm rounded-xl shadow-xl outline-none ring-2 ring-white focus:outline-none transition-transform"
        >
          Skip to main content
        </a>

        {!appReady && <GlobalLoader />}

        {/* Floating Header */}
        <Header onOpenMemory={() => setMemoryOpen(true)} />

        <nav aria-label="MindPal views" className="flex justify-center pt-16 pb-2 px-4 flex-shrink-0">
          <TabBar activeTab={resolvedActiveTab} onTabChange={setActiveTab} showPresenceTab={showPresenceTab} />
        </nav>

        <AppPanels
          activeTab={resolvedActiveTab}
          hasMessages={hasMessages}
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
