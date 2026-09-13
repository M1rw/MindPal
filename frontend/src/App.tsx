import React, { useState, useEffect, useRef } from 'react';
import { Header } from './components/ui/Header';
import { ChatCanvas } from './components/chat/ChatCanvas';
import { ChatInput, ChatInputHandle } from './components/chat/ChatInput';
import { VoiceOverlay } from './components/voice/VoiceOverlay';
import { MemoryInspector } from './components/memory/MemoryInspector';
import { SettingsModal } from './components/settings/SettingsModal';
import { StreakModal } from './components/streak/StreakModal';
import { AuthModal } from './components/auth/AuthModal';
import { GlobalLoader } from './components/ui/GlobalLoader';
import { Toast } from './components/ui/Toast';
import { useAuthStore, useSessionStore } from './store';
import { onAuthStateChange, getIdToken, getAppCheckToken } from './services/auth';

export const App: React.FC = () => {
  const [memoryOpen, setMemoryOpen] = useState(false);
  const [appReady, setAppReady] = useState(false);
  const chatInputRef = useRef<ChatInputHandle>(null);

  const { setUser, setIsLoading } = useAuthStore();
  const { setAuth } = useSessionStore();

  useEffect(() => {
    // Initialize auth listener
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

    // Simulate loader transition / bootstrap complete
    const timer = setTimeout(() => {
      setAppReady(true);
    }, 800);

    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
  }, []);

  return (
    <div className="h-dvh-safe flex flex-col bg-gemini-bg dark:bg-gemini-darkBg text-gemini-text dark:text-gemini-darkText font-sans overflow-hidden transition-colors duration-300 selection:bg-brand-primary selection:text-white relative">
      {/* Initial Global Loader overlay */}
      {!appReady && <GlobalLoader />}

      {/* Floating Header */}
      <Header onOpenMemory={() => setMemoryOpen(true)} />

      {/* Main Chat Canvas & Composer */}
      <main className="flex-1 flex flex-col max-w-5xl w-full mx-auto overflow-hidden relative">
        <ChatCanvas onSelectMood={(moodText) => chatInputRef.current?.sendMessage(moodText)} />
        <ChatInput ref={chatInputRef} />
      </main>

      {/* Overlays & Modals */}
      <VoiceOverlay />
      <MemoryInspector isOpen={memoryOpen} onClose={() => setMemoryOpen(false)} />
      <SettingsModal onOpenMemory={() => setMemoryOpen(true)} />
      <StreakModal />
      <AuthModal />

      {/* Global Toast Notification System */}
      <Toast />
    </div>
  );
};
