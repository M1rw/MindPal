import React, { useState } from 'react';
import { useSettingsStore, useChatStore } from '../../store';
import { Moon, Sun, User, Flame, ChevronDown, Check } from 'lucide-react';

interface HeaderProps {
  onOpenProfile: () => void;
}

export const Header: React.FC<HeaderProps> = ({ onOpenProfile }) => {
  const { settings, updateSettings } = useSettingsStore();
  const { activeModel, setActiveModel } = useChatStore();
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [streak] = useState(1);

  const toggleTheme = () => {
    const nextTheme = settings.theme === 'dark' ? 'light' : 'dark';
    updateSettings({ theme: nextTheme });
    if (nextTheme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  };

  const models = [
    { id: 'pro', name: 'MindPal Pro 2.5', desc: 'Deep reflection & clinical reasoning' },
    { id: 'flash-lite', name: 'MindPal Fast', desc: 'Rapid responses & light checks' },
  ];

  return (
    <header className="w-full bg-transparent px-6 py-4 flex items-center justify-between text-slate-800 dark:text-slate-200">
      {/* Left logo & Model dropdown */}
      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-lg tracking-tight text-slate-900 dark:text-slate-100">MindPal</span>
          <span className="text-[11px] font-medium text-slate-500 bg-slate-100 dark:bg-slate-800 dark:text-slate-400 px-2 py-0.5 rounded-md border border-slate-200 dark:border-slate-700">
            Local
          </span>
        </div>

        <div className="relative">
          <button
            onClick={() => setModelDropdownOpen(!modelDropdownOpen)}
            className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-slate-100 dark:bg-slate-800/80 text-xs text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
          >
            <span>{models.find((m) => m.id === activeModel)?.name || 'MindPal Pro'}</span>
            <ChevronDown className="w-3 h-3 text-slate-400" />
          </button>

          {modelDropdownOpen && (
            <div className="absolute top-full mt-2 left-0 w-60 bg-white dark:bg-[#1e1f20] border border-slate-200 dark:border-slate-700 rounded-2xl shadow-xl py-2 z-50 animate-fade-in">
              {models.map((m) => (
                <button
                  key={m.id}
                  onClick={() => {
                    setActiveModel(m.id);
                    setModelDropdownOpen(false);
                  }}
                  className="w-full px-4 py-2 text-left hover:bg-slate-100 dark:hover:bg-slate-800 flex items-center justify-between transition-colors"
                >
                  <div>
                    <p className="text-xs font-semibold text-slate-900 dark:text-slate-100">{m.name}</p>
                    <p className="text-[10px] text-slate-400">{m.desc}</p>
                  </div>
                  {activeModel === m.id && <Check className="w-3.5 h-3.5 text-blue-500" />}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Right controls */}
      <div className="flex items-center gap-4 text-sm font-medium">
        <button
          onClick={toggleTheme}
          className="p-1.5 rounded-full text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
          title="Toggle theme"
        >
          {settings.theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </button>

        <div className="flex items-center gap-1 text-slate-700 dark:text-slate-300" title="Streak">
          <span>{streak}</span>
          <Flame className="w-4 h-4 text-amber-500 fill-amber-500" />
        </div>

        <button
          onClick={onOpenProfile}
          className="p-1.5 rounded-full text-slate-600 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
          title="Profile & Settings"
        >
          <User className="w-4 h-4" />
        </button>
      </div>
    </header>
  );
};
