import React, { useState, useEffect, useRef } from 'react';
import { Header } from './components/ui/Header';
import { TabBar, AppTab } from './components/ui/TabBar';
import { ChatCanvas } from './components/chat/ChatCanvas';
import { ChatInput, ChatInputHandle } from './components/chat/ChatInput';
import { PresenceShell } from './components/presence/PresenceShell';
import { VoiceOverlay } from './components/voice/VoiceOverlay';
import { MemoryInspector } from './components/memory/MemoryInspector';
import { SettingsModal } from './components/settings/SettingsModal';
import { StreakModal } from './components/streak/StreakModal';
import { AuthModal } from './components/auth/AuthModal';
import { GlobalLoader } from './components/ui/GlobalLoader';
import { Toast } from './components/ui/Toast';
import { Plus, MessageSquare } from 'lucide-react';
import { useAuthStore, useSessionStore, useChatStore } from './store';
import { onAuthStateChange, getIdToken, getAppCheckToken } from './services/auth';

export const App: React.FC = () => {
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [appReady, setAppReady] = useState(false);
  const [activeTab, setActiveTab] = useState<AppTab>('chat');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const chatInputRef = useRef<ChatInputHandle>(null);

  const { setUser, setIsLoading } = useAuthStore();
  const { setAuth } = useSessionStore();
  const { messages } = useChatStore();

  const hasMessages = messages.length > 0;

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
            'absolute inset-0 flex transition-all duration-220 ease-out',
            activeTab === 'chat'
              ? 'opacity-100 scale-100 pointer-events-auto'
              : 'opacity-0 scale-[0.98] pointer-events-none',
          ].join(' ')}
          style={{ transitionTimingFunction: 'cubic-bezier(0.4,0,0.2,1)' }}
        >
          {/* Chat Sidebar — collapses on mobile */}
          {hasMessages && (
            <aside
              className={[
                'flex-shrink-0 border-r border-black/[0.06] dark:border-white/[0.06] flex flex-col',
                'bg-gemini-bg dark:bg-gemini-darkBg transition-all duration-200 overflow-hidden',
                sidebarOpen ? 'w-52' : 'w-0',
              ].join(' ')}
            >
              <div className="p-3 flex flex-col gap-1 min-w-[13rem]">
                <div className="flex items-center gap-2 px-2.5 py-2 rounded-xl bg-[#4140FD]/10 dark:bg-[#4140FD]/15 text-[#4140FD] dark:text-[#A39CF9]">
                  <MessageSquare className="w-3.5 h-3.5 flex-shrink-0" />
                  <span className="text-xs font-semibold truncate">My Chat</span>
                </div>
                <button
                  type="button"
                  className="flex items-center gap-2 px-2.5 py-2 rounded-xl text-xs text-zinc-500 dark:text-zinc-400 hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>New Chat</span>
                </button>
              </div>
            </aside>
          )}

          {/* Chat Content */}
          <div className="flex-1 flex flex-col max-w-5xl w-full mx-auto overflow-hidden">
            <ChatCanvas onSelectMood={(moodText) => chatInputRef.current?.sendMessage(moodText)}>
              {!hasMessages && <ChatInput ref={chatInputRef} />}
            </ChatCanvas>
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

      {/* Global Toast */}
      <Toast />
    </div>
  );
};

