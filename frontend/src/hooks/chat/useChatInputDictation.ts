import { useCallback, useRef, useState } from 'react';
import type { ToastKind } from '../../types/index';
import { joinText } from '../../utils/ui/joinText';
import { useDictationAudioAnalysis } from './useDictationAudioAnalysis';
import { useFlagsStore } from '../../store/flags.ts';
import { useSettingsStore } from '../../store/settings.ts';
import { dictationApi } from '../../services/api/dictation.ts';
import { MAX_RECORDING_MS, browserDictationLang, recordingMimeType } from '../../utils/chat/dictation.ts';

/**
 * Composer dictation, two engines:
 *
 *  - server (preferred): record the voice note, send it to /api/transcribe.
 *    Whisper detects the language itself, so Arabic, English, and both in one
 *    sentence all come back in the script they were spoken in. No live words
 *    while speaking (like ChatGPT's dictation); the text lands on stop.
 *  - browser (fallback, when no server provider is configured or the browser
 *    cannot record): SpeechRecognition with live words, in ONE language, taken
 *    from the voice-language setting or the browser, never a hard-coded en-US.
 */

type SpeechRecognitionResultLike = {
  isFinal?: boolean;
  [index: number]: { transcript: string; isFinal?: boolean };
};

type SpeechRecognitionEventLike = {
  results: ArrayLike<SpeechRecognitionResultLike>;
};

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onstart: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
};

type SpeechRecognitionCtorLike = new () => SpeechRecognitionLike;

interface UseChatInputDictationOptions {
  input: string;
  setInput: (value: string) => void;
  pushToast: (message: string, kind?: ToastKind) => void;
  onSend: (text: string) => void;
}

function canRecord(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.MediaRecorder !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia) &&
    recordingMimeType((type) => MediaRecorder.isTypeSupported(type)) !== ''
  );
}

export const useChatInputDictation = ({ input, setInput, pushToast, onSend }: UseChatInputDictationOptions) => {
  const [isDictating, setIsDictating] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const stopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const discardRef = useRef(false);
  const isDictatingRef = useRef(false);
  const savedPreDictationTextRef = useRef('');
  const recognitionAnchorRef = useRef('');
  const latestComposerRef = useRef(input);
  latestComposerRef.current = input;
  const { audioVolume, startAudioAnalysis, stopAudioAnalysis } = useDictationAudioAnalysis({
    isDictatingRef,
  });

  const releaseMic = useCallback(() => {
    if (stopTimerRef.current) clearTimeout(stopTimerRef.current);
    stopTimerRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    stopAudioAnalysis();
  }, [stopAudioAnalysis]);

  // ── Server engine ────────────────────────────────────────────────────────

  /** Stop recording; resolves with the composer text after transcription (or the text as it was). */
  const finishRecording = useCallback(async (): Promise<string> => {
    const recorder = recorderRef.current;
    recorderRef.current = null;
    isDictatingRef.current = false;
    setIsDictating(false);
    if (!recorder) {
      releaseMic();
      return latestComposerRef.current;
    }
    const stopped = new Promise<void>((resolve) => {
      recorder.addEventListener('stop', () => resolve(), { once: true });
    });
    if (recorder.state !== 'inactive') recorder.stop();
    await stopped;
    releaseMic();
    const audio = new Blob(chunksRef.current, { type: recorder.mimeType || 'audio/webm' });
    chunksRef.current = [];
    if (discardRef.current || audio.size === 0) return latestComposerRef.current;

    setIsTranscribing(true);
    try {
      const { text } = await dictationApi.transcribe(audio);
      const next = text ? joinText(latestComposerRef.current, text) : latestComposerRef.current;
      latestComposerRef.current = next;
      setInput(next);
      if (!text) pushToast("Didn't catch any words. Try again a little closer to the mic.", 'warning');
      return next;
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : '';
      pushToast(message || "Couldn't transcribe that. Please try again.", 'error');
      return latestComposerRef.current;
    } finally {
      setIsTranscribing(false);
    }
  }, [pushToast, releaseMic, setInput]);

  const startRecording = useCallback(() => {
    savedPreDictationTextRef.current = input;
    discardRef.current = false;
    chunksRef.current = [];
    isDictatingRef.current = true;
    setIsDictating(true);
    // Both calls start inside the tap (iOS needs the gesture for the mic and the meter).
    const streamPromise = navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    void startAudioAnalysis(streamPromise);
    streamPromise
      .then((stream) => {
        if (!isDictatingRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        const mimeType = recordingMimeType((type) => MediaRecorder.isTypeSupported(type));
        const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 32_000 });
        recorder.ondataavailable = (event) => {
          if (event.data.size > 0) chunksRef.current.push(event.data);
        };
        recorderRef.current = recorder;
        recorder.start(1000);
        stopTimerRef.current = setTimeout(() => {
          pushToast('Voice notes are up to 3 minutes. Transcribing what you said.', 'info');
          void finishRecording();
        }, MAX_RECORDING_MS);
      })
      .catch((error: unknown) => {
        isDictatingRef.current = false;
        setIsDictating(false);
        releaseMic();
        const denied = error instanceof DOMException && (error.name === 'NotAllowedError' || error.name === 'SecurityError');
        pushToast(
          denied
            ? 'Microphone access is off. Allow it in your browser settings to dictate.'
            : "Couldn't start the microphone.",
          'error',
        );
      });
  }, [finishRecording, input, pushToast, releaseMic, startAudioAnalysis]);

  // ── Browser engine (fallback) ────────────────────────────────────────────

  const startBrowserRecognition = useCallback(() => {
    const speechWindow = window as typeof window & {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
      __MOCK_SPEECH_RECOGNITION__?: new () => SpeechRecognitionLike;
    };

    let SpeechRecognition: SpeechRecognitionCtorLike | undefined =
      (speechWindow.__MOCK_SPEECH_RECOGNITION__ as SpeechRecognitionCtorLike | undefined) ||
      (speechWindow.SpeechRecognition as SpeechRecognitionCtorLike | undefined) ||
      (speechWindow.webkitSpeechRecognition as SpeechRecognitionCtorLike | undefined);

    if (!SpeechRecognition) {
      if (new URLSearchParams(window.location.search).get('mockSpeech') === 'true') {
        SpeechRecognition = class implements SpeechRecognitionLike {
          continuous = true;
          interimResults = true;
          lang = 'en-US';
          onstart: (() => void) | null = null;
          onresult: ((event: SpeechRecognitionEventLike) => void) | null = null;
          onerror: ((event: { error: string }) => void) | null = null;
          onend: (() => void) | null = null;

          start() {
            setTimeout(() => {
              this.onstart?.();
              setTimeout(() => {
                this.onresult?.({ results: [[{ transcript: 'hello how are you', isFinal: true }]] });
              }, 120);
            }, 60);
          }

          stop() {
            this.onend?.();
          }
        };
      } else {
        pushToast('Voice dictation is not supported in this browser. Try Chrome, Edge, or Safari.', 'warning');
        return;
      }
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = browserDictationLang(
        useSettingsStore.getState().settings.voiceLanguage,
        typeof navigator !== 'undefined' ? navigator.language : undefined,
      );

      savedPreDictationTextRef.current = input;
      recognitionAnchorRef.current = input;
      latestComposerRef.current = input;
      isDictatingRef.current = true;

      recognition.onstart = () => {
        setIsDictating(true);
        void startAudioAnalysis();
      };

      recognition.onresult = (event: SpeechRecognitionEventLike) => {
        let finalTranscript = '';
        let interimTranscript = '';

        for (let i = 0; i < event.results.length; ++i) {
          const result = event.results[i];
          const transcript = (result?.[0]?.transcript ?? '').trim();
          if (!transcript) continue;

          if (result?.isFinal) {
            finalTranscript = joinText(finalTranscript, transcript);
          } else {
            interimTranscript = joinText(interimTranscript, transcript);
          }
        }

        const speechChunk = joinText(finalTranscript, interimTranscript);
        const next = joinText(recognitionAnchorRef.current, speechChunk);
        latestComposerRef.current = next;
        setInput(next);
      };

      recognition.onerror = (event: { error: string }) => {
        if (event.error === 'not-allowed') {
          pushToast('Microphone access denied. Please allow microphone permissions.', 'error');
          isDictatingRef.current = false;
          setIsDictating(false);
          stopAudioAnalysis();
        }
      };

      recognition.onend = () => {
        if (isDictatingRef.current) {
          recognitionAnchorRef.current = latestComposerRef.current;
          try {
            recognition.start();
          } catch {
            isDictatingRef.current = false;
            setIsDictating(false);
            stopAudioAnalysis();
          }
        } else {
          setIsDictating(false);
          stopAudioAnalysis();
        }
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch {
      isDictatingRef.current = false;
      setIsDictating(false);
      stopAudioAnalysis();
    }
  }, [input, pushToast, setInput, startAudioAnalysis, stopAudioAnalysis]);

  // ── Public API (unchanged shape, plus isTranscribing) ────────────────────

  const usingServer = () =>
    Boolean(useFlagsStore.getState().flags.dictation_server) &&
    canRecord() &&
    !(window as typeof window & { __MOCK_SPEECH_RECOGNITION__?: unknown }).__MOCK_SPEECH_RECOGNITION__;

  const startDictation = useCallback(() => {
    if (isTranscribing) return;
    if (usingServer()) startRecording();
    else startBrowserRecognition();
  }, [isTranscribing, startBrowserRecognition, startRecording]);

  const cancelDictation = useCallback(() => {
    isDictatingRef.current = false;
    if (recorderRef.current) {
      discardRef.current = true;
      void finishRecording();
    }
    recognitionRef.current?.stop();
    releaseMic();
    setInput(savedPreDictationTextRef.current);
    setIsDictating(false);
  }, [finishRecording, releaseMic, setInput]);

  const confirmDictation = useCallback(async (): Promise<string> => {
    if (recorderRef.current || isTranscribing) return finishRecording();
    isDictatingRef.current = false;
    recognitionRef.current?.stop();
    stopAudioAnalysis();
    setIsDictating(false);
    return latestComposerRef.current;
  }, [finishRecording, isTranscribing, stopAudioAnalysis]);

  const confirmAndSendDictation = useCallback(async () => {
    const text = await confirmDictation();
    // Let the composer render the final text before it is sent.
    setTimeout(() => {
      if (text.trim()) onSend(text);
    }, 50);
  }, [confirmDictation, onSend]);

  return {
    isDictating,
    isTranscribing,
    audioVolume,
    startDictation,
    cancelDictation,
    confirmDictation,
    confirmAndSendDictation,
  };
};
