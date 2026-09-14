import { useCallback, useRef, useState } from 'react';
import type { ToastKind } from '../types/index';
import { useDictationAudioAnalysis } from './useDictationAudioAnalysis';

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

export const useChatInputDictation = ({
  input,
  setInput,
  pushToast,
  onSend,
}: UseChatInputDictationOptions) => {
  const [isDictating, setIsDictating] = useState(false);

  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const isDictatingRef = useRef(false);
  const savedPreDictationTextRef = useRef('');
  const { audioVolume, startAudioAnalysis, stopAudioAnalysis } = useDictationAudioAnalysis({
    isDictatingRef,
  });

  const startDictation = useCallback(() => {
    const speechWindow = window as typeof window & {
      SpeechRecognition?: new () => SpeechRecognitionLike;
      webkitSpeechRecognition?: new () => SpeechRecognitionLike;
      __MOCK_SPEECH_RECOGNITION__?: new () => SpeechRecognitionLike;
    };

    let SpeechRecognition: SpeechRecognitionCtorLike | undefined =
      (speechWindow.SpeechRecognition as SpeechRecognitionCtorLike | undefined) ||
      (speechWindow.webkitSpeechRecognition as SpeechRecognitionCtorLike | undefined) ||
      (speechWindow.__MOCK_SPEECH_RECOGNITION__ as SpeechRecognitionCtorLike | undefined);

    if (!SpeechRecognition) {
      if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('mockSpeech') === 'true') {
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
              if (this.onstart) this.onstart();
              setTimeout(() => {
                if (this.onresult) {
                  this.onresult({
                    results: [[{ transcript: 'hello how are you', isFinal: true }]],
                  });
                }
              }, 120);
            }, 60);
          }

          stop() {
            if (this.onend) this.onend();
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
      recognition.lang = 'en-US';

      savedPreDictationTextRef.current = input;
      isDictatingRef.current = true;

      recognition.onstart = () => {
        setIsDictating(true);
        startAudioAnalysis();
      };

      recognition.onresult = (event: SpeechRecognitionEventLike) => {
        let finalTranscript = '';
        let interimTranscript = '';

        for (let i = 0; i < event.results.length; ++i) {
          const result = event.results[i];
          const transcript = result?.[0]?.transcript ?? '';

          if (result?.isFinal) {
            finalTranscript += transcript;
          } else {
            interimTranscript += transcript;
          }
        }

        const speechChunk = (finalTranscript + ' ' + interimTranscript).trim();

        const base = savedPreDictationTextRef.current;
        const separator = base && !base.endsWith(' ') ? ' ' : '';
        setInput(base + (speechChunk ? separator + speechChunk : ''));
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

  const cancelDictation = useCallback(() => {
    isDictatingRef.current = false;
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
    stopAudioAnalysis();
    setInput(savedPreDictationTextRef.current);
    setIsDictating(false);
  }, [setInput, stopAudioAnalysis]);

  const confirmDictation = useCallback(() => {
    isDictatingRef.current = false;
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
    stopAudioAnalysis();
    setIsDictating(false);
  }, [stopAudioAnalysis]);

  const confirmAndSendDictation = useCallback(() => {
    confirmDictation();
    setTimeout(() => {
      onSend(input);
    }, 50);
  }, [confirmDictation, input, onSend]);

  return {
    isDictating,
    audioVolume,
    startDictation,
    cancelDictation,
    confirmDictation,
    confirmAndSendDictation,
  };
};
