import React, { useEffect, useState } from 'react';
import {
  useSettingsStore,
  useSessionStore,
  useAuthStore,
  useToastStore,
  useChangelogStore,
  useMemoryStore,
} from '../../store';
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
import { Modal } from '../ui/Modal';
import { SettingsMobileNav } from './SettingsMobileNav';

interface SettingsModalProps {
  onOpenMemory?: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = () => {
  const { isOpen, setIsOpen, activeTab, setActiveTab, settings, updateSettings } = useSettingsStore();
  const memoryOpen = useMemoryStore((state) => state.isOpen);
  const { clearAuth } = useSessionStore();
  const { user, setUser, openAuthModal } = useAuthStore();
  const { push: pushToast } = useToastStore();

  const closeSettings = () => {
    if (useMemoryStore.getState().isOpen) return;
    setIsOpen(false);
  };

  const [changelogData, setChangelogData] = useState<ChangelogResponse | null>(null);
  const [changelogLoading, setChangelogLoading] = useState(false);
  const [changelogError, setChangelogError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    if (!isOpen || activeTab !== 'features') {
      return;
    }

    let cancelled = false;
    setChangelogLoading(true);
    setChangelogError(null);

    ApiClient.getChangelog()
      .then((data) => {
        if (cancelled) return;
        setChangelogData(data);
        useChangelogStore.getState().setChangelog(data);
      })
      .catch(() => {
        if (!cancelled) {
          setChangelogError('Unable to load release notes right now.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setChangelogLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [isOpen, activeTab]);

  const handleSignOut = async () => {
    try {
      await signOut();
      clearAuth();
      setUser(null);
      pushToast('Signed out successfully', 'info');
      setIsOpen(false);
    } catch (err) {
      console.error('Sign out error:', err);
      pushToast('Sign out failed. Please try again.', 'error');
    }
  };

  const handleExportData = async () => {
    if (!user) {
      pushToast('Sign in to download account data stored on the server.', 'error');
      return;
    }
    setExporting(true);
    try {
      const blob = await ApiClient.exportUserData();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `mindpal-data-${new Date().toISOString().split('T')[0]}.json`;
      a.click();
      window.URL.revokeObjectURL(url);
      pushToast('Account data downloaded', 'success');
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : 'Download failed. Please try again.';
      pushToast(message, 'error');
    } finally {
      setExporting(false);
    }
  };

  const handleDeleteData = async () => {
    if (!user) {
      pushToast('Sign in to delete account data stored on the server.', 'error');
      return;
    }
    if (
      !window.confirm(
        'Permanently delete your MindPal profile, saved memory, and synced chats on the server? Chat history on this device is not removed. This cannot be undone.',
      )
    ) {
      return;
    }
    setDeleting(true);
    try {
      await ApiClient.deleteUserData();
      pushToast('Server profile, memory, and synced chats were deleted', 'info');
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : 'Delete failed. Please try again.';
      pushToast(message, 'error');
    } finally {
      setDeleting(false);
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
    <Modal
      id="profile-modal"
      panelId="profile-content"
      open={isOpen}
      onClose={closeSettings}
      label="Settings"
      size="panel"
      flush
      inert={memoryOpen}
      swipeable={!memoryOpen}
      panelClassName="settings-modal-panel"
    >
      <SettingsSidebar
          navTabs={navTabs}
          activeTab={activeTab}
          onChangeTab={setActiveTab}
          onClose={closeSettings}
          onSignOut={handleSignOut}
          user={user}
        />

        <SettingsMobileNav
          navTabs={navTabs}
          activeTab={activeTab}
          onChangeTab={setActiveTab}
          onClose={closeSettings}
          categoryLabel="Select settings category"
        />

        <section className="flex-1 min-w-0 flex flex-col h-full overflow-hidden">
          <div className="flex-1 overflow-y-auto px-5 sm:px-8 py-6 sm:py-8 custom-scrollbar">
            {activeTab === 'general' && (
              <GeneralSettingsTab settings={settings} updateSettings={updateSettings} />
            )}

            {activeTab === 'mental-health' && (
              <MentalHealthSettingsTab
                onSignIn={() => {
                  setIsOpen(false);
                  openAuthModal();
                }}
              />
            )}

            {activeTab === 'features' && (
              <FeaturesSettingsTab
                changelogData={changelogData}
                changelogLoading={changelogLoading}
                changelogError={changelogError}
                onOpenWhatsNew={() => {
                  useChangelogStore.getState().setChangelog(changelogData);
                  useChangelogStore.getState().setIsOpen(true);
                  setIsOpen(false);
                }}
              />
            )}

            {activeTab === 'voice' && (
              <VoiceSettingsTab settings={settings} updateSettings={updateSettings} />
            )}

            {activeTab === 'analytics' && (
              <AnalyticsSettingsTab
                onSignIn={() => {
                  setIsOpen(false);
                  openAuthModal();
                }}
              />
            )}

            {activeTab === 'personalization' && (
              <PersonalizationSettingsTab
                settings={settings}
                updateSettings={updateSettings}
                onOpenMemory={() => {
                  useMemoryStore.getState().setIsOpen(true, 'summary', [], { returnToSettings: true });
                }}
              />
            )}

            {activeTab === 'usage' && <UsageSettingsTab />}

            {activeTab === 'data' && (
              <DataControlsSettingsTab
                signedIn={Boolean(user)}
                exporting={exporting}
                deleting={deleting}
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
    </Modal>
  );
};
