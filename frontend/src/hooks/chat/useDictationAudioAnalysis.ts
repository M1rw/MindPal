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
  // A stream handed in by the recorder is theirs to stop; only our own is ours.
  const ownsStreamRef = useRef(false);

  const stopAudioAnalysis = useCallback(() => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }

    if (mediaStreamRef.current && ownsStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
    }
    mediaStreamRef.current = null;

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

  /**
   * Drive the level meter. Pass the recorder's stream (or the promise of it,
   * so this still runs inside the tap) to share one microphone; with nothing
   * passed the meter opens its own.
   */
  const startAudioAnalysis = useCallback(async (shared?: MediaStream | Promise<MediaStream>) => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) return;

      const webkitWindow = window as typeof window & {
        webkitAudioContext?: typeof AudioContext;
      };
      const AudioCtx = window.AudioContext || webkitWindow.webkitAudioContext;
      if (!AudioCtx) return;

      // Created and resumed before the first await, while still inside the tap:
      // iOS Safari keeps a context made after an await suspended, so the level
      // meter never moved there.
      const audioCtx = new AudioCtx();
      audioContextRef.current = audioCtx;
      void audioCtx.resume?.().catch(() => {});

      let stream: MediaStream;
      try {
        ownsStreamRef.current = !shared;
        stream = await (shared ?? navigator.mediaDevices.getUserMedia({ audio: true }));
      } catch (error) {
        void audioCtx.close().catch(() => {});
        audioContextRef.current = null;
        throw error;
      }
      mediaStreamRef.current = stream;

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
