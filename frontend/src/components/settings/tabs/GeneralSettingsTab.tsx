import React from 'react';
import { triggerHaptic } from '../../../utils/ui/haptics';
import { setTheme } from '../../../utils/ui/theme';
import { setConfirmSkipped } from '../../../store/confirm.ts';
import { resetQuickActions, useQuickActions, DEFAULT_QUICK_ACTIONS } from '../../../store/palette.ts';
import { SettingsHeader, SettingsRow, SettingsSelect, settingsGhostButtonClass } from '../SettingsPrimitives';
import type { SettingsTabContentProps } from './types';

const THEME_OPTIONS = [
  { value: 'system' as const, label: 'System', description: 'Follow your device.' },
  { value: 'light' as const, label: 'Light' },
  { value: 'dark' as const, label: 'Dark' },
];

const ON_OFF: ReadonlyArray<{ value: 'true' | 'false'; label: string; description?: string }> = [
  { value: 'true', label: 'On' },
  { value: 'false', label: 'Off' },
];

export const GeneralSettingsTab: React.FC<SettingsTabContentProps> = ({ settings, updateSettings }) => {
  const quickActions = useQuickActions();
  const quickActionsCustomised =
    quickActions.length !== DEFAULT_QUICK_ACTIONS.length || quickActions.some((id, i) => id !== DEFAULT_QUICK_ACTIONS[i]);

  return (
    <div className="space-y-8">
      <SettingsHeader
        title="General"
        description="Appearance and behaviour. Signed in, these follow your account to every device."
      />

      <SettingsRow label="Theme" description="Light, dark, or match your device.">
        <SettingsSelect ariaLabel="Theme" value={settings.theme} options={THEME_OPTIONS} onChange={(next) => setTheme(next)} />
      </SettingsRow>
      <SettingsRow label="Ask before starting a new chat" description="A quick check so a tap doesn't leave a conversation by accident.">
        <SettingsSelect
          ariaLabel="Ask before starting a new chat"
          value={settings.skipConfirm['new-chat'] ? 'false' : 'true'}
          options={ON_OFF}
          onChange={(next) => setConfirmSkipped('new-chat', next === 'false')}
        />
      </SettingsRow>
      <SettingsRow
        label="Search quick actions"
        description={
          quickActionsCustomised
            ? `${quickActions.length} pinned. Change them with Customize in search (${navigator.platform?.startsWith('Mac') ? '⌘' : 'Ctrl'} K).`
            : 'The defaults. Change them with Customize in search.'
        }
      >
        <button
          type="button"
          className={settingsGhostButtonClass}
          disabled={!quickActionsCustomised}
          onClick={() => resetQuickActions()}
        >
          Reset
        </button>
      </SettingsRow>
      <SettingsRow label="Vibration" description="Short vibrations while MindPal replies, on phones that support it." last>
        <SettingsSelect
          ariaLabel="Vibration"
          value={settings.soundEnabled ? 'true' : 'false'}
          options={ON_OFF}
          onChange={(next) => {
            const enabled = next === 'true';
            updateSettings({ soundEnabled: enabled });
            triggerHaptic(enabled, enabled ? 'success' : 'selection');
          }}
        />
      </SettingsRow>
    </div>
  );
};
