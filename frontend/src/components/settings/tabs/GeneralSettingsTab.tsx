import React from 'react';
import { STORAGE_KEYS } from '../../../constants/storage';
import { SettingsHeader, SettingsRow, SettingsSelect } from '../SettingsPrimitives';
import type { SettingsTabContentProps } from './types';

const THEME_OPTIONS = [
  { value: 'light' as const, label: 'Light' },
  { value: 'dark' as const, label: 'Dark' },
];

const SOUND_OPTIONS: ReadonlyArray<{
  value: 'true' | 'false';
  label: string;
  description: string;
}> = [
  { value: 'true', label: 'Enabled', description: 'Play subtle audio feedback and chimes.' },
  { value: 'false', label: 'Muted', description: 'Keep all interface sounds quiet.' },
];

export const GeneralSettingsTab: React.FC<SettingsTabContentProps> = ({ settings, updateSettings }) => {
  const isDark = document.documentElement.classList.contains('dark');
  const theme = isDark ? 'dark' : 'light';

  return (
    <div className="space-y-8">
      <SettingsHeader
        title="General"
        description="Appearance for this device. These choices stay in this browser."
      />

      <SettingsRow label="Theme" description="Light or dark interface. Saved on this device.">
        <SettingsSelect
          ariaLabel="Theme"
          value={theme}
          options={THEME_OPTIONS}
          onChange={(next) => {
            updateSettings({ theme: next });
            if (next === 'dark') {
              document.documentElement.classList.add('dark');
              document.documentElement.classList.remove('light');
              localStorage.setItem(STORAGE_KEYS.THEME, 'dark');
            } else {
              document.documentElement.classList.remove('dark');
              document.documentElement.classList.add('light');
              localStorage.setItem(STORAGE_KEYS.THEME, 'light');
            }
          }}
        />
      </SettingsRow>
      <SettingsRow
        label="Interface sounds"
        description="Subtle chime and audio cues when interacting with controls."
        last
      >
        <SettingsSelect
          ariaLabel="Interface sounds"
          value={settings.soundEnabled ? 'true' : 'false'}
          options={SOUND_OPTIONS}
          onChange={(next) => {
            updateSettings({ soundEnabled: next === 'true' });
          }}
        />
      </SettingsRow>
    </div>
  );
};
