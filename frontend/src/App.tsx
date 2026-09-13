import React, { useState } from 'react';
import { Header } from './components/ui/Header';
import { ChatCanvas } from './components/chat/ChatCanvas';
import { ChatInput } from './components/chat/ChatInput';
import { VoiceOverlay } from './components/voice/VoiceOverlay';
import { MemoryInspector } from './components/memory/MemoryInspector';
import { SettingsModal } from './components/settings/SettingsModal';
import { useSettingsStore } from './store';

export const App: React.FC = () => {
  const [memoryOpen, setMemoryOpen] = useState(false);
  const { setIsOpen: setSettingsOpen } = useSettingsStore();

  return (
    <div className="min-h-screen flex flex-col bg-white dark:bg-[#131314] font-sans text-slate-900 dark:text-slate-100 selection:bg-blue-500 selection:text-white">
      <Header onOpenProfile={() => setSettingsOpen(true)} />

      <main className="flex-1 flex flex-col max-w-4xl w-full mx-auto overflow-hidden">
        <ChatCanvas />
        <ChatInput />
      </main>

      <VoiceOverlay />
      <MemoryInspector isOpen={memoryOpen} onClose={() => setMemoryOpen(false)} />
      <SettingsModal />
    </div>
  );
};
