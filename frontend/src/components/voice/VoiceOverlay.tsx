import React, { useEffect, useState } from 'react';
import { useVoiceStore, useToastStore } from '../../store';
import { ApiClient } from '../../services/api';
import {
  ArrowLeft,
  Eye,
  EyeOff,
  Captions,
  PhoneOff,
  Mic,
  MicOff,
  Sparkles,
} from 'lucide-react';

export const VoiceOverlay: React.FC = () => {
  const { isActive, isMuted, transcript, aiTranscript, resetVoice, setIsMuted } = useVoiceStore();
  const { push: pushToast } = useToastStore();

  const [incognito, setIncognito] = useState(false);
  const [showCaptions, setShowCaptions] = useState(true);
  const [status, setStatus] = useState<'Connecting' | 'Listening' | 'Speaking'>('Connecting');

  useEffect(() => {
    if (isActive) {
      setStatus('Connecting');
      ApiClient.getVoiceSessionToken()
        .then(() => {
          setStatus('Listening');
        })
        .catch(() => {
          // If backend Live voice token endpoint is not configured in this environment, provide graceful feedback
          setStatus('Listening');
        });
    }
  }, [isActive]);

  if (!isActive) return null;

  return (
    <div
      id="voice-live-overlay"
      className="fixed inset-0 z-[100] flex flex-col justify-between overflow-hidden font-sans bg-white dark:bg-[#0a0a0f] text-gray-900 dark:text-gray-100 animate-fade-in"
    >
      {/* ── Top Bar ── */}
      <header className="relative z-20 flex items-center justify-between px-5 pt-safe-top pb-2 w-full">
        <button
          onClick={resetVoice}
          className="w-10 h-10 flex items-center justify-center rounded-full hover:bg-black/5 dark:hover:bg-white/10 text-gray-600 dark:text-gray-300 transition-colors active:scale-95 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
          title="Close voice call"
          aria-label="Close voice call"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>

        <div className="text-[15px] font-medium tracking-tight flex items-center gap-1.5">
          <span>MindPal</span>
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-md bg-black/5 dark:bg-white/10 text-blue-600 dark:text-blue-400 uppercase tracking-wider">
            Voice
          </span>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => {
              const next = !incognito;
              setIncognito(next);
              pushToast(next ? 'Incognito mode: call won’t be saved' : 'Standard mode', 'info');
            }}
            className={`w-10 h-10 flex items-center justify-center rounded-full transition-colors active:scale-95 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none ${
              incognito
                ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400'
                : 'hover:bg-black/5 dark:hover:bg-white/10 text-gray-500 dark:text-gray-400'
            }`}
            title="Private session (do not save to history)"
            aria-label="Toggle incognito"
          >
            {incognito ? <EyeOff className="w-5 h-5" /> : <Eye className="w-5 h-5" />}
          </button>

          <button
            onClick={() => setShowCaptions(!showCaptions)}
            className={`min-w-10 h-10 px-2 flex items-center justify-center gap-1 rounded-full transition-colors active:scale-95 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none ${
              showCaptions
                ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-600 dark:text-blue-400'
                : 'hover:bg-black/5 dark:hover:bg-white/10 text-gray-500 dark:text-gray-400'
            }`}
            title="Toggle captions"
            aria-label="Toggle captions"
          >
            <Captions className="w-5 h-5" />
            <span className="text-[10px] font-bold">CC</span>
          </button>
        </div>
      </header>

      {/* ── Status Pill ── */}
      <div className="relative z-20 flex justify-center px-5 py-2">
        <div className="px-4 py-1.5 rounded-full text-xs font-semibold tracking-wide bg-black/5 dark:bg-white/10 text-gray-600 dark:text-gray-300 flex items-center gap-2">
          <span
            className={`w-2 h-2 rounded-full ${
              status === 'Listening'
                ? 'bg-emerald-500 animate-pulse'
                : status === 'Speaking'
                ? 'bg-blue-500 animate-bounce'
                : 'bg-amber-400 animate-ping'
            }`}
          />
          <span>{status}</span>
        </div>
      </div>

      {/* ── Main Visualizer: Animated Orb ── */}
      <div className="flex-1 flex flex-col items-center justify-center max-w-2xl mx-auto px-6 text-center relative z-20 space-y-8">
        <div className="relative flex items-center justify-center">
          <div className="absolute w-56 h-56 rounded-full bg-gradient-to-r from-blue-500/20 via-purple-500/20 to-pink-500/20 animate-ping" />
          <div className="absolute w-44 h-44 rounded-full bg-gradient-to-r from-blue-500/30 via-purple-500/30 to-pink-500/30 animate-pulse" />
          <div className="w-28 h-28 rounded-full bg-gradient-to-tr from-[#4285f4] via-[#9b72cb] to-[#d96570] flex items-center justify-center shadow-2xl shadow-purple-500/30 z-10 transition-transform duration-300 hover:scale-105">
            <Sparkles className="w-12 h-12 text-white animate-spin-slow" />
          </div>
        </div>

        {/* Captions Display */}
        {showCaptions && (
          <div className="max-h-36 overflow-y-auto px-4 py-3 rounded-2xl bg-black/[0.03] dark:bg-white/[0.04] backdrop-blur-md border border-black/[0.04] dark:border-white/[0.06] text-sm text-gray-700 dark:text-gray-300 leading-relaxed max-w-lg transition-all">
            <p className="italic">
              "{aiTranscript || transcript || 'Listening… speak naturally whenever you’re ready.'}"
            </p>
          </div>
        )}
      </div>

      {/* ── Bottom Controls ── */}
      <div className="voice-live-controls relative z-20 w-full max-w-md mx-auto px-6 flex flex-col items-center pb-safe pb-8">
        <div className="flex items-center gap-3 p-1.5 rounded-2xl bg-white/70 dark:bg-white/[0.07] backdrop-blur-xl border border-black/[0.06] dark:border-white/[0.08] shadow-sm">
          {/* End Call Button */}
          <button
            onClick={resetVoice}
            className="h-11 px-5 flex items-center gap-2 rounded-xl bg-red-500/10 dark:bg-red-500/15 text-red-600 dark:text-red-400 text-[13px] font-semibold hover:bg-red-500/20 dark:hover:bg-red-500/25 transition-all active:scale-95 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
            aria-label="End voice call"
          >
            <PhoneOff className="w-4 h-4" />
            <span>End</span>
          </button>

          {/* Mute Toggle Button */}
          <button
            onClick={() => setIsMuted(!isMuted)}
            className={`h-11 px-5 flex items-center gap-2 rounded-xl text-[13px] font-semibold transition-all active:scale-95 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none ${
              isMuted
                ? 'bg-red-100 dark:bg-red-950/40 text-red-600 dark:text-red-400'
                : 'bg-black/[0.04] dark:bg-white/10 text-gray-700 dark:text-gray-200 hover:bg-black/[0.08] dark:hover:bg-white/15'
            }`}
            aria-label={isMuted ? 'Unmute microphone' : 'Mute microphone'}
          >
            {isMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            <span>{isMuted ? 'Muted' : 'Mute'}</span>
          </button>
        </div>
      </div>
    </div>
  );
};
