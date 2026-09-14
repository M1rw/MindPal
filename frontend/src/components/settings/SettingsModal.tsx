import React, { useEffect, useState } from 'react';
import {
  useSettingsStore,
  useSessionStore,
  useAuthStore,
  useToastStore,
  useChangelogStore,
} from '../../store';
import type { UserInsightsResponse } from '../../types';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { ApiClient } from '../../services/api/index';
import { signOut } from '../../services/auth/index';
import type { ChangelogResponse } from '../../types';
import { SettingsSidebar } from './SettingsSidebar';
import {
  GeneralSettingsTab,
  MentalHealthSettingsTab,
  FeaturesSettingsTab,
  VoiceSettingsTab,
  AnalyticsSettingsTab,
  PersonalizationSettingsTab,
  UsageSettingsTab,
  DataControlsSettingsTab,
  SecuritySettingsTab,
  AccountSettingsTab,
} from './tabs';
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
} from 'lucide-react';

interface SettingsModalProps {
  onOpenMemory?: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ onOpenMemory }) => {
  const { isOpen, setIsOpen, activeTab, setActiveTab, settings, updateSettings } = useSettingsStore();
  const { clearAuth } = useSessionStore();
  const { user, setUser, openAuthModal } = useAuthStore();
  const { push: pushToast } = useToastStore();
  const modalContentRef = useFocusTrap<HTMLDivElement>({
    isOpen,
    onClose: () => setIsOpen(false),
    autoFocus: true,
  });

  const [changelogData, setChangelogData] = useState<ChangelogResponse | null>(null);
  const [insightsData, setInsightsData] = useState<UserInsightsResponse | null>(null);
  const [insightsLoading, setInsightsLoading] = useState(false);
  const [insightsError, setInsightsError] = useState<string | null>(null);
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

  useEffect(() => {
    if (!isOpen || (activeTab !== 'analytics' && activeTab !== 'usage')) {
      return;
    }

    let cancelled = false;
    setInsightsLoading(true);
    setInsightsError(null);

    ApiClient.getUserInsights()
      .then((data) => {
        if (!cancelled) {
          setInsightsData(data);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('Failed to load insights:', err);
          setInsightsError('Unable to load insights right now.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setInsightsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
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
        ref={modalContentRef}
        id="profile-content"
        className="bg-white dark:bg-[#18181B] w-full sm:max-w-[860px] h-[92vh] sm:h-[min(760px,92vh)] flex flex-col sm:flex-row rounded-t-2xl sm:rounded-2xl shadow-xl overflow-hidden border-0 sm:border border-black/[0.08] dark:border-white/[0.08] text-zinc-900 dark:text-zinc-100 animate-fade-in"
      >
        <SettingsSidebar
          navTabs={navTabs}
          activeTab={activeTab}
          onChangeTab={setActiveTab}
          onClose={() => setIsOpen(false)}
          onSignOut={handleSignOut}
          user={user}
        />

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
            {activeTab === 'general' && (
              <GeneralSettingsTab settings={settings} updateSettings={updateSettings} />
            )}

            {activeTab === 'mental-health' && <MentalHealthSettingsTab />}

            {activeTab === 'features' && (
              <FeaturesSettingsTab
                changelogData={changelogData}
                onOpenWhatsNew={() => {
                  useChangelogStore.getState().setChangelog(changelogData);
                  useChangelogStore.getState().setIsOpen(true);
                  setIsOpen(false);
                }}
              />
            )}

            {activeTab === 'voice' && <VoiceSettingsTab />}

            {activeTab === 'analytics' && (
              <AnalyticsSettingsTab
                insights={insightsData}
                loading={insightsLoading}
                error={insightsError}
              />
            )}

            {activeTab === 'personalization' && (
              <PersonalizationSettingsTab
                settings={settings}
                updateSettings={updateSettings}
                onOpenMemory={() => {
                  setIsOpen(false);
                  onOpenMemory?.();
                }}
              />
            )}

            {activeTab === 'usage' && (
              <UsageSettingsTab
                insights={insightsData}
                loading={insightsLoading}
                error={insightsError}
              />
            )}

            {activeTab === 'data' && (
              <DataControlsSettingsTab
                exporting={exporting}
                onExportData={handleExportData}
                onDeleteData={handleDeleteData}
              />
            )}

            {activeTab === 'security' && <SecuritySettingsTab />}

            {activeTab === 'account' && (
              <AccountSettingsTab
                user={user}
                onSignOut={handleSignOut}
                onSignIn={() => {
                  setIsOpen(false);
                  openAuthModal();
                }}
              />
            )}
          </div>
        </section>
      </div>
    </div>
  );
};
