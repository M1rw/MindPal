import React, { useEffect, useState } from 'react';
import { useSettingsStore, useSessionStore } from '../../store';
import { ApiClient } from '../../services/api';
import { FeatureChangelogItem } from '../../types';
import { X, Settings, User, Brain, Volume2, Sparkles, LogOut, Check } from 'lucide-react';

export const SettingsModal: React.FC = () => {
  const { isOpen, setIsOpen, activeTab, setActiveTab, settings, updateSettings } = useSettingsStore();
  const { clearAuth, isAuthenticated } = useSessionStore();
  const [changelog, setChangelog] = useState<FeatureChangelogItem[]>([]);

  useEffect(() => {
    if (isOpen && activeTab === 'changelog') {
      ApiClient.getChangelog()
        .then(setChangelog)
        .catch((err) => console.error('Failed to load changelog:', err));
    }
  }, [isOpen, activeTab]);

  if (!isOpen) return null;

  const tabs = [
    { id: 'general', label: 'General', icon: Settings },
    { id: 'personalization', label: 'Personalization', icon: User },
    { id: 'memory', label: 'Memory & Brain', icon: Brain },
    { id: 'voice', label: 'Voice & Sound', icon: Volume2 },
    { id: 'changelog', label: "What's New", icon: Sparkles },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div className="bg-slate-900 border border-slate-800 rounded-3xl shadow-2xl w-full max-w-3xl h-[80vh] flex flex-col md:flex-row overflow-hidden animate-fade-in text-slate-100">
        {/* Sidebar */}
        <div className="w-full md:w-64 bg-slate-950/80 border-r border-slate-800 p-4 flex flex-col justify-between">
          <div>
            <h2 className="text-xl font-bold text-slate-100 px-3 py-2 mb-2">Settings</h2>
            <nav className="space-y-1">
              {tabs.map((tab) => {
                const Icon = tab.icon;
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none ${
                      isActive
                        ? 'bg-blue-600 text-white shadow-sm'
                        : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    {tab.label}
                  </button>
                );
              })}
            </nav>
          </div>

          {isAuthenticated && (
            <button
              onClick={() => {
                clearAuth();
                setIsOpen(false);
              }}
              className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-red-400 hover:bg-red-950/40 transition-colors focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:outline-none"
            >
              <LogOut className="w-4 h-4" />
              Sign Out
            </button>
          )}
        </div>

        {/* Content */}
        <div className="flex-1 flex flex-col h-full bg-slate-900">
          <div className="flex items-center justify-between p-4 border-b border-slate-800">
            <h3 className="text-lg font-semibold text-slate-100 capitalize">{activeTab} Settings</h3>
            <button
              onClick={() => setIsOpen(false)}
              className="p-2 rounded-xl text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-6 space-y-6">
            {activeTab === 'general' && (
              <div className="space-y-4">
                <label className="block text-sm font-medium text-slate-300">Theme</label>
                <div className="grid grid-cols-3 gap-3">
                  {(['light', 'dark', 'system'] as const).map((t) => (
                    <button
                      key={t}
                      onClick={() => updateSettings({ theme: t })}
                      className={`px-4 py-3 rounded-2xl border text-sm capitalize font-medium flex items-center justify-between ${
                        settings.theme === t
                          ? 'border-blue-500 bg-blue-950/40 text-blue-400'
                          : 'border-slate-800 bg-slate-950/40 text-slate-300 hover:bg-slate-800'
                      }`}
                    >
                      {t}
                      {settings.theme === t && <Check className="w-4 h-4 text-blue-400" />}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {activeTab === 'personalization' && (
              <div className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">Base Communication Style</label>
                  <select
                    value={settings.personalization.baseStyle}
                    onChange={(e) =>
                      updateSettings({
                        personalization: { ...settings.personalization, baseStyle: e.target.value as any },
                      })
                    }
                    className="w-full rounded-xl border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 focus:ring-2 focus:ring-blue-500 focus:outline-none"
                  >
                    <option value="concise">Concise & Direct</option>
                    <option value="balanced">Balanced Guidance</option>
                    <option value="detailed">Detailed & Exploratory</option>
                  </select>
                </div>
              </div>
            )}

            {activeTab === 'changelog' && (
              <div className="space-y-4">
                {changelog.length === 0 ? (
                  <p className="text-sm text-slate-400">Loading changelog...</p>
                ) : (
                  changelog.map((item, idx) => (
                    <div key={idx} className="border-b border-slate-800 pb-4">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-semibold text-slate-100">{item.title}</span>
                        <span className="text-xs bg-blue-950 text-blue-400 border border-blue-800/50 px-2 py-0.5 rounded-full">{item.version}</span>
                      </div>
                      <ul className="list-disc list-inside text-xs text-slate-400 space-y-1">
                        {item.changes.map((c, i) => (
                          <li key={i}>{c}</li>
                        ))}
                      </ul>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
