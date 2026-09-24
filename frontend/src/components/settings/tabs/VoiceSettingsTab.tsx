import React, { useEffect, useRef, useState } from 'react';
import { Loader2, Pause, Play } from 'lucide-react';
import { useFlagsStore, useVoiceStore } from '../../../store';
import {
  SettingsHeader,
  SettingsRow,
  SettingsSelect,
  settingsControlButtonClass,
  settingsPrimaryButtonClass,
} from '../SettingsPrimitives';
import type { SettingsTabContentProps } from './types';
import { useIsSignedIn } from '../../../hooks/session/useAccountStatus.ts';
import { personaPalette, rgb } from '../../../voice/face/personaColor.ts';

const VOICE_LIST: ReadonlyArray<{
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
  { value: 'Achird', label: 'Achird', description: 'Friendly and easy to talk to.' },
  { value: 'Umbriel', label: 'Umbriel', description: 'Easy-going and relaxed.' },
  { value: 'Vindemiatrix', label: 'Vindemiatrix', description: 'Gentle and soft-spoken.' },
  { value: 'Sadachbia', label: 'Sadachbia', description: 'Lively and bright.' },
  { value: 'Laomedeia', label: 'Laomedeia', description: 'Upbeat and cheerful.' },
  { value: 'Zephyr', label: 'Zephyr', description: 'Bright and clear.' },
];

/** The voice's orb colours, as a small dot, so the list shows how each call will look. */
export function voiceSwatchGradient(voice: string): string {
  const [edge, middle, highlight] = personaPalette(voice).stops;
  return `radial-gradient(circle at 35% 30%, ${rgb(highlight)} 0%, ${rgb(middle)} 50%, ${rgb(edge)} 100%)`;
}

const VOICE_OPTIONS = VOICE_LIST.map((voice) => ({
  ...voice,
  leading: (
    <span
      aria-hidden="true"
      className="h-4 w-4 flex-shrink-0 rounded-full"
      style={{ background: voiceSwatchGradient(voice.value) }}
    />
  ),
}));

/** Which sample to play: the spoken-language setting, else the browser's language. */
export function previewLanguage(voiceLanguage: string | undefined, navigatorLanguage: string | undefined): 'en' | 'ar' {
  if (voiceLanguage === 'ar') return 'ar';
  if (voiceLanguage && voiceLanguage !== 'auto') return 'en';
  return (navigatorLanguage || '').toLowerCase().startsWith('ar') ? 'ar' : 'en';
}

function previewSources(voice: string, language: 'en' | 'ar'): string[] {
  // Their language first, then the other sample.
  return [language, language === 'ar' ? 'en' : 'ar'].map((lang) => `/assets/voice-previews/${voice}-${lang}.mp3`);
}

type PreviewState = 'idle' | 'loading' | 'playing' | 'missing';

/** Plays a short sample of a voice (scripts/ops/voice_previews.py). */
const VoicePreviewButton: React.FC<{ voice: string; language: 'en' | 'ar' }> = ({ voice, language }) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [state, setState] = useState<PreviewState>('idle');
  useEffect(
    () => () => {
      audioRef.current?.pause();
      audioRef.current = null;
    },
    [],
  );
  useEffect(() => {
    // A different voice or language: stop the old sample, and fetch the new one
    // in the background so pressing Preview plays at once.
    audioRef.current?.pause();
    audioRef.current = null;
    setState('idle');
    const warm = new Audio();
    warm.preload = 'auto';
    warm.src = previewSources(voice, language)[0];
    return () => {
      warm.removeAttribute('src');
    };
  }, [voice, language]);
  const toggle = () => {
    if (state === 'playing' || state === 'loading') {
      audioRef.current?.pause();
      audioRef.current = null;
      setState('idle');
      return;
    }
    const sources = previewSources(voice, language);
    const tryPlay = (index: number) => {
      if (index >= sources.length) {
        setState('missing');
        return;
      }
      const audio = new Audio(sources[index]);
      audioRef.current = audio;
      // A missing file fires both onerror and a rejected play(): move on once.
      let movedOn = false;
      const next = () => {
        if (movedOn || audioRef.current !== audio) return;
        movedOn = true;
        tryPlay(index + 1);
      };
      // Loading until sound actually starts.
      audio.onplaying = () => {
        if (audioRef.current === audio) setState('playing');
      };
      audio.onended = () => {
        if (audioRef.current === audio) setState('idle');
      };
      audio.onerror = next;
      void audio.play().catch(next);
    };
    setState('loading');
    tryPlay(0);
  };
  if (state === 'missing') {
    return <span className="text-[13px] text-content-muted">No sample yet</span>;
  }
  const busy = state === 'loading';
  return (
    <button
      type="button"
      onClick={toggle}
      aria-busy={busy}
      aria-label={state === 'playing' ? `Stop the ${voice} sample` : busy ? `Loading the ${voice} sample` : `Hear ${voice}`}
      className={settingsControlButtonClass}
    >
      {busy ? (
        <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin" />
      ) : state === 'playing' ? (
        <Pause className="h-3.5 w-3.5 flex-shrink-0" />
      ) : (
        <Play className="h-3.5 w-3.5 flex-shrink-0" />
      )}
      {state === 'playing' ? 'Stop' : 'Preview'}
    </button>
  );
};

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
        description="Dictation understands any language, even two in one sentence. A live call is a signed-in preview: 30 minutes per day, not a crisis line."
      />

      <div>
        <SettingsRow
          label="Dictation"
          description="The microphone on the composer turns what you say into text, in whatever languages you speak. It is not a phone-style conversation."
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
              description="Choose the voice MindPal uses during live calls. Preview plays a short sample."
            >
              <div className="flex items-center gap-2">
                <VoicePreviewButton
                  voice={selectedVoice}
                  language={previewLanguage(selectedLang, typeof navigator !== 'undefined' ? navigator.language : undefined)}
                />
                <SettingsSelect
                  ariaLabel="Companion voice"
                  value={selectedVoice}
                  options={VOICE_OPTIONS}
                  onChange={(voiceModel) => updateSettings({ voiceModel })}
                />
              </div>
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
