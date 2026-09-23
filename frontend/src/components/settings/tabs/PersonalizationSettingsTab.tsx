import React, { useCallback, useEffect, useState } from 'react';
import { ApiClient, type AdaptiveProfileSummary } from '../../../services/api';
import { useSessionStore } from '../../../store';
import {
  SettingsHeader,
  SettingsRow,
  SettingsSelect,
  settingsDangerButtonClass,
  settingsGhostButtonClass,
  settingsPrimaryButtonClass,
} from '../SettingsPrimitives';
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

const LEARNED_LABELS: Record<string, Record<string, string>> = {
  length: { concise: 'Prefers short replies', detailed: 'Likes fuller, deeper replies' },
  approach: { listen: 'Wants to be heard before advice', advice: 'Likes practical next steps' },
  tone: { direct: 'Prefers a direct tone', gentle: 'Prefers a gentle tone' },
  lists: { off: 'Prefers prose over lists', on: 'Likes structured lists' },
  emoji: { off: 'No emojis', on: 'Emojis welcome' },
  language: { ar: 'Usually writes in Arabic', en: 'Usually writes in English' },
};

/** What MindPal has learned from this account's conversations, with a reset. */
function LearnedPreferences() {
  const isAuthenticated = useSessionStore((state) => state.isAuthenticated);
  const [profile, setProfile] = useState<AdaptiveProfileSummary | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    setStatus('loading');
    try {
      setProfile(await ApiClient.getAdaptation());
      setStatus('idle');
    } catch {
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    if (isAuthenticated) void load();
  }, [isAuthenticated, load]);

  if (!isAuthenticated) {
    return (
      <SettingsRow
        label="Learned preferences"
        description="Sign in and MindPal gradually learns how you like to talk, from your own feedback. Guests are never profiled."
        last
      >
        <span className="text-xs text-content-muted">Signed-in only</span>
      </SettingsRow>
    );
  }

  const learned = Object.entries(profile?.preferences ?? {})
    .map(([dimension, option]) => LEARNED_LABELS[dimension]?.[option])
    .filter((label): label is string => Boolean(label));

  const reset = async () => {
    setConfirming(false);
    try {
      await ApiClient.resetAdaptation();
      await load();
    } catch {
      setStatus('error');
    }
  };

  return (
    <SettingsRow
      label="Learned preferences"
      description={
        status === 'error'
          ? 'Could not load what MindPal has learned. Try again later.'
          : learned.length
            ? `Learned from your conversations and thumbs up/down: ${learned.join(' · ')}. Style only; safety behaviour never changes.`
            : 'Nothing learned yet. Say things like "keep it short" or use thumbs up/down on replies, and MindPal adapts.'
      }
      last
    >
      {confirming ? (
        <div className="flex gap-2">
          <button type="button" onClick={() => setConfirming(false)} className={settingsGhostButtonClass}>
            Cancel
          </button>
          <button type="button" onClick={() => void reset()} className={settingsDangerButtonClass}>
            Forget
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          disabled={!profile || profile.turns_observed === 0}
          className={settingsPrimaryButtonClass}
        >
          Reset
        </button>
      )}
    </SettingsRow>
  );
}

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
      >
        <button type="button" onClick={() => onOpenMemory?.()} className={settingsPrimaryButtonClass}>
          Open memory
        </button>
      </SettingsRow>
      <LearnedPreferences />
    </div>
  </div>
);
