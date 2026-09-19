import React from 'react';
import { SettingsHeader, SettingsRow, SettingsSelect, settingsPrimaryButtonClass } from '../SettingsPrimitives';
import type { SettingsTabContentProps, UserPersonalization } from './types';

const TONE_OPTIONS: ReadonlyArray<{
  value: UserPersonalization['baseStyle'];
  label: string;
  description: string;
}> = [
  { value: 'concise', label: 'Concise', description: 'Shorter replies.' },
  { value: 'balanced', label: 'Balanced', description: 'Default length.' },
  { value: 'detailed', label: 'Detailed', description: 'Longer replies.' },
];

const WARMTH_OPTIONS: ReadonlyArray<{
  value: UserPersonalization['warmth'];
  label: string;
  description: string;
}> = [
  { value: 'warm', label: 'Warm', description: 'Gentler phrasing.' },
  { value: 'neutral', label: 'Neutral', description: 'Even tone.' },
  { value: 'direct', label: 'Direct', description: 'More straightforward.' },
];

const FORMAT_OPTIONS: ReadonlyArray<{
  value: 'true' | 'false';
  label: string;
  description: string;
}> = [
  { value: 'true', label: 'Structured lists', description: 'Headers and bullets where helpful.' },
  { value: 'false', label: 'Flowing prose', description: 'Continuous narrative without lists.' },
];

const EMOJI_OPTIONS: ReadonlyArray<{
  value: 'true' | 'false';
  label: string;
  description: string;
}> = [
  { value: 'true', label: 'Expressive', description: 'Warm emojis where appropriate.' },
  { value: 'false', label: 'None', description: 'Clean text without emojis.' },
];

export const PersonalizationSettingsTab: React.FC<SettingsTabContentProps> = ({
  settings,
  updateSettings,
  onOpenMemory,
}) => (
  <div className="space-y-8">
    <SettingsHeader
      title="Personalization"
      description="Tone and warmth are sent with each request to /api/chat/stream so replies can follow them."
    />

    <div>
      <SettingsRow label="Reply length" description="How compact or detailed replies should be.">
        <SettingsSelect
          ariaLabel="Reply length"
          value={settings.personalization.baseStyle}
          options={TONE_OPTIONS}
          onChange={(baseStyle) =>
            updateSettings({
              personalization: {
                ...settings.personalization,
                baseStyle,
              },
            })
          }
        />
      </SettingsRow>
      <SettingsRow label="Warmth" description="How directly or gently MindPal should speak.">
        <SettingsSelect
          ariaLabel="Warmth"
          value={settings.personalization.warmth}
          options={WARMTH_OPTIONS}
          onChange={(warmth) =>
            updateSettings({
              personalization: {
                ...settings.personalization,
                warmth,
              },
            })
          }
        />
      </SettingsRow>
      <SettingsRow label="Text layout" description="Choose between structured bullets or flowing narrative prose.">
        <SettingsSelect
          ariaLabel="Text layout"
          value={settings.personalization.useHeadersLists ? 'true' : 'false'}
          options={FORMAT_OPTIONS}
          onChange={(val) =>
            updateSettings({
              personalization: {
                ...settings.personalization,
                useHeadersLists: val === 'true',
              },
            })
          }
        />
      </SettingsRow>
      <SettingsRow label="Emojis" description="Include emojis in replies or keep conversation text-only.">
        <SettingsSelect
          ariaLabel="Emojis"
          value={settings.personalization.emojiSupport ? 'true' : 'false'}
          options={EMOJI_OPTIONS}
          onChange={(val) =>
            updateSettings({
              personalization: {
                ...settings.personalization,
                emojiSupport: val === 'true',
              },
            })
          }
        />
      </SettingsRow>
      <SettingsRow
        label="Memory"
        description="Review facts saved from chat. Guests keep them on this device until sign-in."
        last
      >
        <button type="button" onClick={() => onOpenMemory?.()} className={settingsPrimaryButtonClass}>
          Open memory
        </button>
      </SettingsRow>
    </div>
  </div>
);
