import React, { useEffect, useState } from 'react';
import {
  useSettingsStore,
  useSessionStore,
  useAuthStore,
  useToastStore,
  useUsageStore,
  useChangelogStore,
} from '../../store';
import { ApiClient } from '../../services/api';
import { signOut } from '../../services/auth';
import type { ChangelogResponse } from '../../types';
import {
  X,
  Settings,
  Activity,
  Sparkles,
  Mic,
  BarChart2,
  Sliders,
  Gauge,
  Database,
  ShieldCheck,
  User,
  LogOut,
  Download,
  Trash2,
} from 'lucide-react';

interface SettingsModalProps {
  onOpenMemory?: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ onOpenMemory }) => {
  const { isOpen, setIsOpen, activeTab, setActiveTab, settings, updateSettings } = useSettingsStore();
  const { clearAuth } = useSessionStore();
  const { user, setUser, openAuthModal } = useAuthStore();
  const { push: pushToast } = useToastStore();

  const [changelogData, setChangelogData] = useState<ChangelogResponse | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (isOpen && activeTab === 'features') {
      ApiClient.getChangelog()
        .then((data) => {
          setChangelogData(data);
          useChangelogStore.getState().setChangelog(data);
        })
        .catch((err) => console.error('Failed to load changelog:', err));
    }
  }, [isOpen, activeTab]);

  if (!isOpen) return null;

  const handleSignOut = async () => {
    try {
      await signOut();
      clearAuth();
      setUser(null);
      pushToast('Signed out successfully', 'info');
      setIsOpen(false);
    } catch (err) {
      console.error('Sign out error:', err);
    }
  };

  const handleExportData = async () => {
    setExporting(true);
    try {
      const blob = await ApiClient.exportUserData();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mindpal-export-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      window.URL.revokeObjectURL(url);
      pushToast('Data exported successfully', 'success');
    } catch (err) {
      pushToast('Export failed. Make sure you are signed in.', 'error');
    } finally {
      setExporting(false);
    }
  };

  const handleDeleteData = async () => {
    if (!window.confirm('Are you sure you want to delete your MindPal data? This cannot be undone.')) {
      return;
    }
    try {
      await ApiClient.deleteUserData();
      pushToast('All stored user data deleted', 'info');
      setIsOpen(false);
    } catch (err) {
      pushToast('Delete failed. Please try again.', 'error');
    }
  };

  const navTabs = [
    { id: 'general', label: 'General', icon: Settings },
    { id: 'mental-health', label: 'Mental health', icon: Activity },
    { id: 'features', label: 'Features', icon: Sparkles },
    { id: 'voice', label: 'Voice', icon: Mic },
    { id: 'analytics', label: 'Analytics', icon: BarChart2 },
    { id: 'personalization', label: 'Personalization', icon: Sliders },
    { id: 'usage', label: 'Usage', icon: Gauge },
    { id: 'data', label: 'Data controls', icon: Database },
    { id: 'security', label: 'Security', icon: ShieldCheck },
    { id: 'account', label: 'Account', icon: User },
  ];

  return (
    <div
      id="profile-modal"
      className="fixed inset-0 bg-black/35 dark:bg-black/75 backdrop-blur-sm z-50 flex items-end sm:items-center justify-center p-0 sm:p-5 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-label="Settings and Profile"
    >
      <div
        id="profile-content"
        className="bg-white dark:bg-[#18181B] w-full sm:max-w-[860px] h-[92vh] sm:h-[min(760px,92vh)] flex flex-col sm:flex-row rounded-t-2xl sm:rounded-2xl shadow-xl overflow-hidden border-0 sm:border border-black/[0.08] dark:border-white/[0.08] text-zinc-900 dark:text-zinc-100 animate-fade-in"
      >
        {/* Desktop Sidebar */}
        <aside className="w-[220px] flex-none bg-zinc-50 dark:bg-[#141416] border-r border-zinc-200 dark:border-zinc-800/80 p-3 hidden sm:flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between px-2 mb-3">
              <span className="text-sm font-bold tracking-tight text-gray-800 dark:text-gray-200">
                Settings
              </span>
              <button
                onClick={() => setIsOpen(false)}
                className="w-8 h-8 rounded-lg flex items-center justify-center hover:bg-gray-200 dark:hover:bg-zinc-800 text-gray-500 dark:text-gray-400 transition-colors focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none"
                title="Close settings"
                type="button"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <nav className="flex flex-col gap-0.5 text-[13px]">
              {navTabs.map((tab) => {
                const Icon = tab.icon;
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    type="button"
                    className={`flex items-center gap-2.5 px-3 py-2 rounded-xl font-medium transition-colors text-left focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none ${
                      isActive
                        ? 'bg-[#4140FD] text-white'
                        : 'text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </nav>
          </div>

          {user && (
            <button
              onClick={handleSignOut}
              type="button"
              className="flex items-center gap-2.5 px-3 py-2 rounded-xl text-[13px] font-medium text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-colors"
            >
              <LogOut className="w-4 h-4" />
              <span>Sign Out</span>
            </button>
          )}
        </aside>

        {/* Mobile Top Header + Tab Selector */}
        <div className="sm:hidden flex items-center justify-between gap-2 px-4 py-3 border-b border-gray-100 dark:border-zinc-800 flex-none">
          <select
            value={activeTab}
            onChange={(e) => setActiveTab(e.target.value)}
            className="flex-1 bg-gray-100 dark:bg-zinc-800 rounded-lg px-3 py-2 text-sm text-gray-900 dark:text-gray-100 outline-none"
            aria-label="Select settings category"
          >
            {navTabs.map((tab) => (
              <option key={tab.id} value={tab.id}>
                {tab.label}
              </option>
            ))}
          </select>
          <button
            onClick={() => setIsOpen(false)}
            className="w-9 h-9 rounded-lg flex items-center justify-center hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-600 dark:text-gray-300"
            type="button"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content Pane */}
        <section className="flex-1 min-w-0 flex flex-col h-full overflow-hidden">
          <div className="flex-1 overflow-y-auto px-5 sm:px-8 py-5 sm:py-6 custom-scrollbar space-y-6">
            {/* ── 1. General ── */}
            {activeTab === 'general' && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">General</h2>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    Basic system preferences and theme controls.
                  </p>
                </div>

                <div className="space-y-4">
                  <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-zinc-800">
                    <div>
                      <span className="text-sm font-medium text-gray-800 dark:text-gray-200">Theme</span>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        Choose your interface visual appearance.
                      </p>
                    </div>
                    <div className="flex gap-1.5">
                      {(['light', 'dark'] as const).map((t) => (
                        <button
                          key={t}
                          onClick={() => {
                            updateSettings({ theme: t });
                            if (t === 'dark') {
                              document.documentElement.classList.add('dark');
                              localStorage.setItem('mindpal_theme', 'dark');
                            } else {
                              document.documentElement.classList.remove('dark');
                              localStorage.setItem('mindpal_theme', 'light');
                            }
                          }}
                          className={`px-3 py-1.5 rounded-xl text-xs font-medium capitalize border transition-all ${
                            (t === 'dark' && document.documentElement.classList.contains('dark')) ||
                            (t === 'light' && !document.documentElement.classList.contains('dark'))
                              ? 'bg-[#4140FD] text-white border-[#4140FD]'
                              : 'border-gray-200 dark:border-zinc-700 hover:bg-gray-100 dark:hover:bg-zinc-800 text-gray-700 dark:text-gray-300'
                          }`}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-zinc-800">
                    <div>
                      <span className="text-sm font-medium text-gray-800 dark:text-gray-200">Sound Effects</span>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        Subtle audio feedback for voice and actions.
                      </p>
                    </div>
                    <input
                      type="checkbox"
                      checked={settings.soundEnabled}
                      onChange={(e) => updateSettings({ soundEnabled: e.target.checked })}
                      className="w-4 h-4 text-[#4140FD] rounded focus:ring-[#4140FD]"
                    />
                  </div>
                </div>
              </div>
            )}

            {/* ── 2. Mental Health ── */}
            {activeTab === 'mental-health' && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                    Mental Health & Safety
                  </h2>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    Protocols designed for supportive, grounded, and clinical safety.
                  </p>
                </div>

                <div className="p-4 rounded-2xl bg-zinc-50 dark:bg-[#1C1C20] border border-zinc-200 dark:border-zinc-800 text-xs text-zinc-900 dark:text-zinc-100 space-y-2">
                  <div className="font-semibold flex items-center gap-1.5">
                    <Activity className="w-4 h-4 text-[#4140FD] dark:text-[#A39CF9]" />
                    24/7 Immediate Crisis Support
                  </div>
                  <p>
                    MindPal is a supportive AI companion, not an emergency medical service. If you are in distress or need immediate help:
                  </p>
                  <ul className="list-disc pl-5 space-y-1">
                    <li><strong>US:</strong> Call or text <strong>988</strong> (Suicide & Crisis Lifeline)</li>
                    <li><strong>UK:</strong> Call <strong>111</strong> or text <strong>SHOUT to 85258</strong></li>
                    <li><strong>Global:</strong> Visit <strong>findahelpline.com</strong> for free local confidential support</li>
                  </ul>
                </div>

                <div className="space-y-4">
                  <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-zinc-800">
                    <div>
                      <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
                        Proactive Grounding Exercises
                      </span>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        Offer 4-7-8 breathing or somatic grounding when detecting high anxiety.
                      </p>
                    </div>
                    <span className="text-xs font-semibold px-2 py-0.5 rounded bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300">
                      Active
                    </span>
                  </div>
                </div>
              </div>
            )}

            {/* ── 3. Features & What's New ── */}
            {activeTab === 'features' && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                    Features & Releases
                  </h2>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    Latest updates and active platform capabilities.
                  </p>
                </div>

                {changelogData?.entries && changelogData.entries.length > 0 ? (
                  <div className="space-y-4">
                    <div className="flex items-center justify-between p-4 rounded-2xl bg-[#4140FD]/10 dark:bg-[#6572F2]/15 border border-[#4140FD]/20">
                      <div>
                        <div className="text-sm font-semibold text-[#4140FD] dark:text-[#A39CF9]">
                          MindPal {changelogData.current_version || '5.0'} Announcement
                        </div>
                        <div className="text-xs text-zinc-600 dark:text-zinc-400 mt-0.5">
                          View the official launch modal with interactive feature tour.
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          useChangelogStore.getState().setChangelog(changelogData);
                          useChangelogStore.getState().setIsOpen(true);
                          setIsOpen(false);
                        }}
                        className="px-3.5 py-1.5 rounded-xl bg-[#4140FD] hover:bg-[#3231d6] text-white text-xs font-semibold shadow-sm active:scale-95 transition-all"
                      >
                        View What's New
                      </button>
                    </div>

                    {changelogData.entries.map((item) => (
                      <div
                        key={item.version}
                        className="p-4 rounded-2xl bg-gray-50 dark:bg-zinc-800/50 border border-gray-100 dark:border-zinc-800"
                      >
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-xs font-bold px-2 py-0.5 rounded bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300">
                            v{item.version}
                          </span>
                          {item.released_at && (
                            <span className="text-[11px] text-gray-400">{item.released_at}</span>
                          )}
                        </div>
                        <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-200 mt-1">
                          {item.title}
                        </h4>
                        {item.summary && (
                          <p className="text-xs text-gray-600 dark:text-gray-300 mt-1 leading-relaxed">
                            {item.summary}
                          </p>
                        )}
                        {item.highlights && item.highlights.length > 0 && (
                          <ul className="mt-2.5 list-disc pl-5 text-xs text-gray-600 dark:text-gray-400 space-y-1">
                            {item.highlights.map((h, i) => (
                              <li key={i}>{h}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-xs text-gray-400">Loading release history…</div>
                )}
              </div>
            )}

            {/* ── 4. Voice ── */}
            {activeTab === 'voice' && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Voice & Audio</h2>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    Configure spoken voice model and speech synthesis.
                  </p>
                </div>

                <div className="space-y-4">
                  <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-zinc-800">
                    <div>
                      <span className="text-sm font-medium text-gray-800 dark:text-gray-200">Voice Model</span>
                      <p className="text-xs text-gray-500 dark:text-gray-400">Gemini Live audio engine</p>
                    </div>
                    <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Advanced Neural</span>
                  </div>

                  <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-zinc-800">
                    <div>
                      <span className="text-sm font-medium text-gray-800 dark:text-gray-200">Language</span>
                      <p className="text-xs text-gray-500 dark:text-gray-400">Automatic multilingual detection</p>
                    </div>
                    <span className="text-xs font-medium text-gray-600 dark:text-gray-300">Auto-detect</span>
                  </div>
                </div>
              </div>
            )}

            {/* ── 5. Analytics ── */}
            {activeTab === 'analytics' && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                    Reflection Analytics
                  </h2>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    Your emotional check-ins and reflection frequency over time.
                  </p>
                </div>

                <div className="p-4 rounded-2xl bg-gray-50 dark:bg-zinc-800/40 border border-gray-100 dark:border-zinc-800">
                  <div className="text-xs font-semibold text-gray-500 dark:text-gray-400 mb-3 uppercase tracking-wider">
                    Weekly Activity
                  </div>
                  <div className="flex items-end gap-2 h-28 px-2 py-2">
                    <div className="flex-1 bg-purple-500/20 rounded-t h-[40%]" title="Mon: 3 check-ins" />
                    <div className="flex-1 bg-purple-500/40 rounded-t h-[65%]" title="Tue: 5 check-ins" />
                    <div className="flex-1 bg-purple-500/30 rounded-t h-[50%]" title="Wed: 4 check-ins" />
                    <div className="flex-1 bg-purple-500/80 rounded-t h-[90%]" title="Thu: 8 check-ins" />
                    <div className="flex-1 bg-purple-500/60 rounded-t h-[70%]" title="Fri: 6 check-ins" />
                    <div className="flex-1 bg-purple-500/30 rounded-t h-[45%]" title="Sat: 3 check-ins" />
                    <div className="flex-1 bg-purple-500/90 rounded-t h-[95%]" title="Sun: 9 check-ins" />
                  </div>
                </div>
              </div>
            )}

            {/* ── 6. Personalization ── */}
            {activeTab === 'personalization' && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                    Personalization
                  </h2>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    Customize how MindPal talks with you.
                  </p>
                </div>

                <div className="space-y-4">
                  <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-zinc-800">
                    <div>
                      <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
                        Base Tone & Style
                      </span>
                      <p className="text-xs text-gray-500 dark:text-gray-400">Conversational balance</p>
                    </div>
                    <select
                      value={settings.personalization.baseStyle}
                      onChange={(e) =>
                        updateSettings({
                          personalization: {
                            ...settings.personalization,
                            baseStyle: e.target.value as any,
                          },
                        })
                      }
                      className="bg-gray-100 dark:bg-zinc-800 px-3 py-1.5 rounded-xl text-xs outline-none"
                    >
                      <option value="concise">Concise</option>
                      <option value="balanced">Balanced</option>
                      <option value="detailed">Detailed</option>
                    </select>
                  </div>

                  <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-zinc-800">
                    <div>
                      <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
                        Warmth & Empathy
                      </span>
                      <p className="text-xs text-gray-500 dark:text-gray-400">Emotional validation level</p>
                    </div>
                    <select
                      value={settings.personalization.warmth}
                      onChange={(e) =>
                        updateSettings({
                          personalization: {
                            ...settings.personalization,
                            warmth: e.target.value as any,
                          },
                        })
                      }
                      className="bg-gray-100 dark:bg-zinc-800 px-3 py-1.5 rounded-xl text-xs outline-none"
                    >
                      <option value="warm">Warm</option>
                      <option value="neutral">Neutral</option>
                      <option value="direct">Direct</option>
                    </select>
                  </div>

                  <div className="flex items-center justify-between py-3 border-b border-gray-100 dark:border-zinc-800">
                    <div>
                      <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
                        Memory Profile
                      </span>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        View and manage what MindPal remembers about your goals and traits.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setIsOpen(false);
                        onOpenMemory?.();
                      }}
                      className="px-3 py-1.5 rounded-xl bg-[#EFF3FB] dark:bg-[#6572F2]/20 text-[#4140FD] dark:text-[#A39CF9] text-xs font-semibold hover:bg-[#E2E6F0] transition-colors"
                    >
                      Manage Memory
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ── 7. Usage ── */}
            {activeTab === 'usage' && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                    Usage & Quota
                  </h2>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    Track your daily and monthly message limits.
                  </p>
                </div>

                <div className="p-4 rounded-2xl bg-gray-50 dark:bg-zinc-800/50 border border-gray-100 dark:border-zinc-800 space-y-3">
                  <div className="flex justify-between items-center text-sm">
                    <span className="font-medium text-gray-800 dark:text-gray-200">Tier</span>
                    <span className="px-2 py-0.5 rounded-md bg-[#EFF3FB] dark:bg-[#6572F2]/20 text-[#4140FD] dark:text-[#A39CF9] text-xs font-bold uppercase">
                      Preview / Unlimited
                    </span>
                  </div>
                  <div className="flex justify-between items-center text-xs text-gray-500 dark:text-gray-400">
                    <span>Pro clinical messages: 2× weight</span>
                    <span>Reset: Daily at 00:00 UTC</span>
                  </div>
                </div>
              </div>
            )}

            {/* ── 8. Data Controls ── */}
            {activeTab === 'data' && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                    Data Controls
                  </h2>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    Export or delete your personal conversations and memories.
                  </p>
                </div>

                <div className="space-y-3">
                  <div className="flex items-center justify-between p-4 rounded-2xl bg-gray-50 dark:bg-zinc-800/40 border border-gray-100 dark:border-zinc-800">
                    <div>
                      <h4 className="text-sm font-semibold text-gray-800 dark:text-gray-200">
                        Export Data
                      </h4>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        Download a JSON copy of all memories and conversations.
                      </p>
                    </div>
                    <button
                      type="button"
                      disabled={exporting}
                      onClick={handleExportData}
                      className="px-3.5 py-2 rounded-xl bg-gray-200 dark:bg-zinc-700 hover:bg-gray-300 dark:hover:bg-zinc-600 text-xs font-semibold flex items-center gap-1.5 transition-colors"
                    >
                      <Download className="w-3.5 h-3.5" />
                      <span>{exporting ? 'Exporting…' : 'Export JSON'}</span>
                    </button>
                  </div>

                  <div className="flex items-center justify-between p-4 rounded-2xl bg-red-50/50 dark:bg-red-950/20 border border-red-100 dark:border-red-900/30">
                    <div>
                      <h4 className="text-sm font-semibold text-red-600 dark:text-red-400">
                        Delete All Data
                      </h4>
                      <p className="text-xs text-gray-500 dark:text-gray-400">
                        Permanently erase your chat logs and memory graph.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={handleDeleteData}
                      className="px-3.5 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-xs font-semibold flex items-center gap-1.5 transition-colors"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Delete</span>
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* ── 9. Security ── */}
            {activeTab === 'security' && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Security</h2>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    End-to-end security and in-memory credential storage.
                  </p>
                </div>

                <div className="p-4 rounded-2xl bg-gray-50 dark:bg-zinc-800/40 border border-gray-100 dark:border-zinc-800 space-y-2 text-xs text-gray-600 dark:text-gray-300">
                  <p className="font-semibold text-gray-900 dark:text-gray-100">Security Architecture:</p>
                  <ul className="list-disc pl-5 space-y-1">
                    <li>Session tokens are held strictly in memory and are never persisted in localStorage.</li>
                    <li>Firebase AppCheck verifies client legitimacy to prevent unauthorized traffic.</li>
                    <li>Clinical guardrails inspect all input and output text in real time.</li>
                  </ul>
                </div>
              </div>
            )}

            {/* ── 10. Account ── */}
            {activeTab === 'account' && (
              <div className="space-y-6">
                <div>
                  <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">Account</h2>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                    Manage your identity and authentication status.
                  </p>
                </div>

                {user ? (
                  <div className="p-5 rounded-2xl bg-gray-50 dark:bg-zinc-800/40 border border-gray-100 dark:border-zinc-800 space-y-4">
                    <div className="flex items-center gap-4">
                      {user.photoURL ? (
                        <img
                          src={user.photoURL}
                          alt="Avatar"
                          className="w-14 h-14 rounded-full border border-gray-300 dark:border-zinc-600 object-cover"
                        />
                      ) : (
                        <div className="w-14 h-14 rounded-full bg-[#4140FD] text-white flex items-center justify-center font-bold text-xl">
                          {(user.displayName || user.email || 'U').charAt(0).toUpperCase()}
                        </div>
                      )}
                      <div>
                        <h4 className="text-base font-bold text-gray-900 dark:text-gray-100">
                          {user.displayName || 'MindPal Member'}
                        </h4>
                        <p className="text-xs text-gray-500 dark:text-gray-400">{user.email || 'No email'}</p>
                        <p className="text-[11px] font-mono text-gray-400 dark:text-gray-500 mt-0.5">
                          UID: {user.uid.slice(0, 12)}…
                        </p>
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={handleSignOut}
                      className="w-full py-2.5 rounded-xl border border-red-200 dark:border-red-900/50 hover:bg-red-50 dark:hover:bg-red-950/30 text-xs font-semibold text-red-600 dark:text-red-400 transition-colors"
                    >
                      Sign Out
                    </button>
                  </div>
                ) : (
                  <div className="p-6 rounded-2xl bg-gray-50 dark:bg-zinc-800/40 border border-gray-100 dark:border-zinc-800 text-center space-y-4">
                    <p className="text-sm text-gray-700 dark:text-gray-300">
                      You are currently browsing as a guest. Sign in to sync your reflections and memories across devices.
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setIsOpen(false);
                        openAuthModal();
                      }}
                      className="px-6 py-2.5 rounded-xl bg-[#4140FD] hover:bg-[#5251fd] text-white text-xs font-bold transition-colors"
                    >
                      Sign In or Create Account
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
