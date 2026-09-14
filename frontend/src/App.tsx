import React, { useState, useEffect, useRef } from 'react';
import { Header } from './components/ui/Header';
import { TabBar, AppTab } from './components/ui/TabBar';
import { ChatCanvas } from './components/chat/ChatCanvas';
import { ChatInput, ChatInputHandle } from './components/chat/ChatInput';
import { ChatHistoryModal } from './components/chat/ChatHistoryModal';
import { PresenceShell } from './components/presence/PresenceShell';
import { VoiceOverlay } from './components/voice/VoiceOverlay';
import { MemoryInspector } from './components/memory/MemoryInspector';
import { SettingsModal } from './components/settings/SettingsModal';
import { StreakModal } from './components/streak/StreakModal';
import { AuthModal } from './components/auth/AuthModal';
import { ChangelogModal } from './components/changelog/ChangelogModal';
import { GlobalLoader } from './components/ui/GlobalLoader';
import { Toast } from './components/ui/Toast';
import { useAuthStore, useSessionStore, useChatStore, useChangelogStore, useChatHistoryStore } from './store';
import { onAuthStateChange, getIdToken, getAppCheckToken } from './services/auth';
import { ApiClient } from './services/api';

export const App: React.FC = () => {
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [appReady, setAppReady] = useState(false);
  const [activeTab, setActiveTab] = useState<AppTab>('chat');
  const chatInputRef = useRef<ChatInputHandle>(null);
  const sessionIdRef = useRef<string>(`sess_${Date.now()}`);

  const { setUser, setIsLoading } = useAuthStore();
  const { setAuth } = useSessionStore();
  const { messages } = useChatStore();
  const { sessions, activeSessionId, saveSession, setActiveSessionId } = useChatHistoryStore();

  const hasMessages = messages.length > 0;

  // Sync session ID when activeSessionId changes (e.g. user loaded history session)
  useEffect(() => {
    if (activeSessionId) {
      sessionIdRef.current = activeSessionId;
    }
  }, [activeSessionId]);

  // Reset session ID when messages are cleared (new chat)
  useEffect(() => {
    if (messages.length === 0) {
      sessionIdRef.current = `sess_${Date.now()}`;
      if (activeSessionId) {
        setActiveSessionId(null);
      }
    }
  }, [messages.length, activeSessionId, setActiveSessionId]);

  // Auto-save session whenever messages change (debounced)
  useEffect(() => {
    if (messages.length === 0) return;
    const timer = setTimeout(() => {
      const currentId = activeSessionId || sessionIdRef.current;
      const existingSession = sessions.find((s) => s.id === currentId);

      // Derive title from first user message, or preserve existing session title
      const firstUser = messages.find((m) => m.role === 'user');
      const title =
        existingSession?.title && existingSession.title !== 'Conversation'
          ? existingSession.title
          : firstUser
          ? firstUser.content.slice(0, 60).trim() + (firstUser.content.length > 60 ? '…' : '')
          : 'Conversation';

      const createdAt = existingSession?.createdAt || messages[0]?.timestamp || new Date().toISOString();

      saveSession({
        id: currentId,
        title,
        createdAt,
        updatedAt: new Date().toISOString(),
        messages: [...messages],
      });
    }, 1000);
    return () => clearTimeout(timer);
  }, [messages, activeSessionId, sessions, saveSession]);

  useEffect(() => {
    const unsubscribe = onAuthStateChange(async (user) => {
      setUser(user);
      setIsLoading(false);
      if (user) {
        const idToken = await getIdToken();
        const appCheckToken = await getAppCheckToken();
        setAuth(user.uid, idToken, appCheckToken);
      } else {
        setAuth(null, null, null);
      }
    });

    const timer = setTimeout(() => setAppReady(true), 800);

    // Automatic What's New changelog check on mount
    const checkChangelog = async () => {
      try {
        const data = await ApiClient.getChangelog();
        if (!data) return;
        const currentVer = data.current_version || '5.0.0';
        const lastSeen = localStorage.getItem('mindpal_last_seen_changelog');
        const hasMajor = data.entries?.some((e) => e.version === currentVer && e.major);

        if (hasMajor && lastSeen !== currentVer) {
          useChangelogStore.getState().setChangelog(data);
          useChangelogStore.getState().setIsOpen(true);
        }
      } catch (err) {
        console.warn('Changelog check on mount:', err);
      }
    };

    checkChangelog();

    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  return (
    <div className="h-dvh-safe flex flex-col bg-gemini-bg dark:bg-gemini-darkBg text-gemini-text dark:text-gemini-darkText font-sans overflow-hidden transition-colors duration-300 selection:bg-brand-primary selection:text-white relative">
      {!appReady && <GlobalLoader />}

      {/* Floating Header */}
      <Header onOpenMemory={() => setMemoryOpen(true)} />

      {/* Tab Bar — always visible below header */}
      <div className="flex justify-center pt-16 pb-2 px-4 flex-shrink-0">
        <TabBar activeTab={activeTab} onTabChange={setActiveTab} />
      </div>

      {/* Tab Panels with smooth cross-fade transition */}
      <main className="flex-1 flex overflow-hidden relative">

        {/* ── Chat Panel ── */}
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
          {/* Smooth layout transition: empty=center, has messages=bottom */}
          <div
            className={[
              'flex-1 flex flex-col overflow-hidden transition-all duration-400 ease-out',
            ].join(' ')}
          >
            <ChatCanvas onSelectMood={(moodText) => chatInputRef.current?.sendMessage(moodText)}>
              {!hasMessages && <ChatInput ref={chatInputRef} />}
            </ChatCanvas>
          </div>

          {/* Input animates from inside canvas to bottom */}
          <div
            className={[
              'transition-all duration-400 ease-out flex-shrink-0',
              hasMessages
                ? 'opacity-100 translate-y-0 pb-0'
                : 'opacity-0 pointer-events-none translate-y-2 h-0 overflow-hidden',
            ].join(' ')}
            style={{ transitionTimingFunction: 'cubic-bezier(0.4,0,0.2,1)' }}
          >
            {hasMessages && <ChatInput ref={chatInputRef} />}
          </div>
        </div>

        {/* ── Presence Panel ── */}
        <div
          className={[
            'absolute inset-0 flex transition-all duration-250 ease-out overflow-y-auto',
            activeTab === 'presence'
              ? 'opacity-100 scale-100 pointer-events-auto'
              : 'opacity-0 scale-[0.98] pointer-events-none',
          ].join(' ')}
          style={{ transitionTimingFunction: 'cubic-bezier(0.4,0,0.2,1)' }}
        >
          <PresenceShell />
        </div>
      </main>

      {/* Overlays & Modals */}
      <VoiceOverlay />
      <MemoryInspector isOpen={memoryOpen} onClose={() => setMemoryOpen(false)} />
      <SettingsModal onOpenMemory={() => setMemoryOpen(true)} />
      <StreakModal />
      <AuthModal />
      <ChangelogModal />
      <ChatHistoryModal />

      {/* Global Toast */}
      <Toast />
    </div>
  );
};
