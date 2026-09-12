import React, { useState } from 'react';
import { Header } from './components/ui/Header';
import { ChatCanvas } from './components/chat/ChatCanvas';
import { ChatInput } from './components/chat/ChatInput';
import { VoiceOverlay } from './components/voice/VoiceOverlay';
import { MemoryInspector } from './components/memory/MemoryInspector';
import { SettingsModal } from './components/settings/SettingsModal';

export const App: React.FC = () => {
  const [memoryOpen, setMemoryOpen] = useState(false);

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-slate-950 font-sans text-slate-900 dark:text-slate-100 selection:bg-blue-500 selection:text-white">
      <Header onOpenMemory={() => setMemoryOpen(true)} />

      <main className="flex-1 flex flex-col max-w-7xl w-full mx-auto overflow-hidden">
        <ChatCanvas />
        <ChatInput />
      </main>

      <VoiceOverlay />
      <MemoryInspector isOpen={memoryOpen} onClose={() => setMemoryOpen(false)} />
      <SettingsModal />
    </div>
  );
};
