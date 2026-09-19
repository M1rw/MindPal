import { useCallback, useEffect, useRef, useState } from 'react';

interface UseDictationAudioAnalysisOptions {
  isDictatingRef: React.MutableRefObject<boolean>;
}

export function useDictationAudioAnalysis({ isDictatingRef }: UseDictationAudioAnalysisOptions) {
  const [audioVolume, setAudioVolume] = useState(0);

  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);

  const stopAudioAnalysis = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }

    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      try {
        audioContextRef.current.close();
      } catch {
        // ignore
      }
    }

    audioContextRef.current = null;
    analyserRef.current = null;
    setAudioVolume(0);
  }, []);

  const startAudioAnalysis = useCallback(async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) return;

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const webkitWindow = window as typeof window & {
        webkitAudioContext?: typeof AudioContext;
      };
      const AudioCtx = window.AudioContext || webkitWindow.webkitAudioContext;
      if (!AudioCtx) return;

      const audioCtx = new AudioCtx();
      audioContextRef.current = audioCtx;

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.6;
      analyserRef.current = analyser;

      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const updateVolume = () => {
        if (!isDictatingRef.current || !analyserRef.current) return;

        analyserRef.current.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }

        const average = sum / bufferLength;
        const normalized = Math.min(100, Math.round((average / 128) * 100));
        setAudioVolume(normalized);
        animFrameRef.current = requestAnimationFrame(updateVolume);
      };

      animFrameRef.current = requestAnimationFrame(updateVolume);
    } catch {
      // Audio analysis unavailable or permission denied.
    }
  }, [isDictatingRef]);

  useEffect(() => {
    return () => {
      isDictatingRef.current = false;
      stopAudioAnalysis();
    };
  }, [isDictatingRef, stopAudioAnalysis]);

  return {
    audioVolume,
    startAudioAnalysis,
    stopAudioAnalysis,
  };
}
