import React, { useState } from 'react';
import { useSettingsStore, useChatStore } from '../../store';
import { Sparkles, Brain, Settings, Plus, ChevronDown, Check } from 'lucide-react';

interface HeaderProps {
  onOpenMemory: () => void;
}

export const Header: React.FC<HeaderProps> = ({ onOpenMemory }) => {
  const { setIsOpen: setSettingsOpen } = useSettingsStore();
  const { clearMessages, activeModel, setActiveModel } = useChatStore();
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);

  const models = [
    { id: 'pro', name: 'MindPal Pro 2.5', desc: 'Deep reflection & clinical reasoning' },
    { id: 'flash-lite', name: 'MindPal Fast', desc: 'Rapid responses & light checks' },
  ];

  return (
    <header className="sticky top-0 z-30 w-full bg-white/80 dark:bg-slate-900/80 backdrop-blur-md border-b border-slate-200/80 dark:border-slate-800/80 px-4 py-3">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        {/* Brand */}
        <div className="flex items-center gap-3">
          <button
            onClick={clearMessages}
            className="flex items-center gap-2 group text-left focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none rounded-xl"
          >
            <div className="w-8 h-8 rounded-xl bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center text-white shadow-md shadow-blue-500/20 group-hover:scale-105 transition-transform">
              <Sparkles className="w-4 h-4" />
            </div>
            <span className="font-bold text-lg text-slate-800 dark:text-slate-100 tracking-tight">MindPal</span>
          </button>

          {/* Model Selector Dropdown */}
          <div className="relative">
            <button
              onClick={() => setModelDropdownOpen(!modelDropdownOpen)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
            >
              <span>{models.find((m) => m.id === activeModel)?.name || 'MindPal Pro'}</span>
              <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            </button>

            {modelDropdownOpen && (
              <div className="absolute top-full mt-2 left-0 w-64 bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded-2xl shadow-xl py-2 z-50 animate-fade-in">
                {models.map((m) => (
                  <button
                    key={m.id}
                    onClick={() => {
                      setActiveModel(m.id);
                      setModelDropdownOpen(false);
                    }}
                    className="w-full px-4 py-2.5 text-left hover:bg-slate-100 dark:hover:bg-slate-700/60 flex items-start justify-between gap-2 transition-colors"
                  >
                    <div>
                      <p className="text-xs font-semibold text-slate-800 dark:text-slate-100">{m.name}</p>
                      <p className="text-[11px] text-slate-400">{m.desc}</p>
                    </div>
                    {activeModel === m.id && <Check className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          <button
            onClick={clearMessages}
            className="p-2 rounded-xl text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
            title="New Chat"
          >
            <Plus className="w-5 h-5" />
          </button>

          <button
            onClick={onOpenMemory}
            className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-slate-100 dark:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
            title="Memory Profile"
          >
            <Brain className="w-4 h-4 text-blue-500" />
            <span className="hidden sm:inline">Memory Profile</span>
          </button>

          <button
            onClick={() => setSettingsOpen(true)}
            className="p-2 rounded-xl text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
            title="Settings"
          >
            <Settings className="w-5 h-5" />
          </button>
        </div>
      </div>
    </header>
  );
};
