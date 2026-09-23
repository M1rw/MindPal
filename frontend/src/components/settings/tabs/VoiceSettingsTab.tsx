import React from 'react';
import { useFlagsStore, useVoiceStore } from '../../../store';
import { SettingsHeader, SettingsRow, SettingsSelect, settingsPrimaryButtonClass } from '../SettingsPrimitives';
import type { SettingsTabContentProps } from './types';
import { useIsSignedIn } from '../../../hooks/session/useAccountStatus.ts';

const VOICE_OPTIONS: ReadonlyArray<{
  value: string;
  label: string;
  description: string;
}> = [
  { value: 'Sulafat', label: 'Sulafat', description: 'Warm and grounded.' },
  { value: 'Aoede', label: 'Aoede', description: 'Thoughtful and conversational.' },
  { value: 'Charon', label: 'Charon', description: 'Deep and calm.' },
  { value: 'Kore', label: 'Kore', description: 'Clear and direct.' },
  { value: 'Puck', label: 'Puck', description: 'Playful and animated.' },
  { value: 'Fenrir', label: 'Fenrir', description: 'Energetic and expressive.' },
];

const LANGUAGE_OPTIONS: ReadonlyArray<{
  value: string;
  label: string;
  description: string;
}> = [
  { value: 'auto', label: 'Auto-detect', description: 'Naturally match what you speak.' },
  { value: 'en', label: 'English', description: 'Conversational English.' },
  { value: 'ar', label: 'Arabic', description: 'Conversational Arabic.' },
  { value: 'es', label: 'Spanish', description: 'Conversational Spanish.' },
];

export const VoiceSettingsTab: React.FC<Partial<SettingsTabContentProps>> = ({
  settings,
  updateSettings,
}) => {
  const liveEnabled = useFlagsStore((state) => state.flags.voice_enabled);
  const isAuthenticated = useIsSignedIn();
  const setVoiceActive = useVoiceStore((state) => state.setIsActive);

  const selectedVoice = settings?.voiceModel || 'Sulafat';
  const selectedLang = settings?.voiceLanguage || 'auto';

  return (
    <div className="space-y-8">
      <SettingsHeader
        title="Voice"
        description="Spoken input in chat uses your browser. A live duplex call is a signed-in preview: 30 minutes per day, not a crisis line."
      />

      <div>
        <SettingsRow
          label="Dictation"
          description="The microphone on the composer transcribes into the text field. It is not a phone-style conversation."
        >
          <span className="text-sm font-medium text-content-secondary">Available</span>
        </SettingsRow>
        <SettingsRow
          label="Live voice"
          description={
            liveEnabled
              ? 'Preview: signed-in live audio. Each call can last up to 30 minutes, which is also today’s live-voice cap, separate from chat credits. Remaining minutes appear on the call screen after it starts. After the call, MindPal writes a short recap of what was said into this chat. Not general availability.'
              : 'A duplex voice call is not enabled for this account. Dictation remains available.'
          }
        >
          <span className="text-sm font-medium text-content-muted">
            {liveEnabled ? 'Preview' : 'Unavailable'}
          </span>
        </SettingsRow>
        {liveEnabled && updateSettings ? (
          <>
            <SettingsRow
              label="Companion voice"
              description="Choose the voice timbre and tone MindPal uses during live calls."
            >
              <SettingsSelect
                ariaLabel="Companion voice"
                value={selectedVoice}
                options={VOICE_OPTIONS}
                onChange={(voiceModel) => updateSettings({ voiceModel })}
              />
            </SettingsRow>
            <SettingsRow
              label="Spoken language"
              description="Language preference for live duplex audio. Auto adapts to your speech."
            >
              <SettingsSelect
                ariaLabel="Spoken language"
                value={selectedLang}
                options={LANGUAGE_OPTIONS}
                onChange={(voiceLanguage) => updateSettings({ voiceLanguage })}
              />
            </SettingsRow>
          </>
        ) : null}
        {liveEnabled ? (
          <SettingsRow
            label="Start a preview call"
            description={
              isAuthenticated
                ? 'Starting a call asks for microphone access and sends audio to the live speech provider. If the connection does not complete, MindPal stops and you can dictate instead. The live orb responds to speech rhythm and volume, not emotion detection.'
                : 'Guests cannot start a live call. Sign in, then start a preview from here when it is enabled for the account. The live orb responds to speech rhythm and volume, not emotion detection.'
            }
            last
          >
            <button
              type="button"
              className={settingsPrimaryButtonClass}
              onClick={() => setVoiceActive(true)}
              disabled={!isAuthenticated}
            >
              {isAuthenticated ? 'Start preview' : 'Sign in required'}
            </button>
          </SettingsRow>
        ) : (
          <p className="text-sm text-content-secondary leading-relaxed pt-4">
            Voice model selectors would only appear here if a live audio engine were connected for
            this account. Dictation follows the language support of your browser.
          </p>
        )}
      </div>
    </div>
  );
};
