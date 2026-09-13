import React, { useEffect } from 'react';
import { useVoiceStore } from '../../store';
import { ApiClient } from '../../services/api';
import { Mic, MicOff, X, Sparkles } from 'lucide-react';

export const VoiceOverlay: React.FC = () => {
  const { isActive, isMuted, transcript, aiTranscript, resetVoice, setIsMuted } = useVoiceStore();

  useEffect(() => {
    if (isActive) {
      ApiClient.getVoiceToken()
        .then((res) => {
          console.log('Voice token obtained:', res.expires_at);
        })
        .catch((err) => {
          console.error('Failed to get voice token:', err);
        });
    }
  }, [isActive]);

  if (!isActive) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-between bg-slate-950/90 backdrop-blur-xl p-6 md:p-12 animate-fade-in text-white">
      {/* Top Header */}
      <div className="w-full max-w-4xl flex items-center justify-between">
        <div className="flex items-center gap-2 bg-slate-800/60 border border-slate-700/50 px-4 py-2 rounded-full backdrop-blur-md">
          <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
          <span className="text-xs font-medium text-slate-200">Gemini Live Active</span>
        </div>

        <button
          onClick={resetVoice}
          className="p-3 rounded-full bg-slate-800/80 hover:bg-slate-700 text-slate-300 hover:text-white transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
        >
          <X className="w-6 h-6" />
        </button>
      </div>

      {/* Main Visualizer */}
      <div className="flex-1 flex flex-col items-center justify-center max-w-2xl text-center space-y-8 my-8">
        <div className="relative flex items-center justify-center">
          <div className="absolute w-48 h-48 rounded-full bg-blue-500/20 animate-ping" />
          <div className="absolute w-36 h-36 rounded-full bg-indigo-500/30 animate-pulse" />
          <div className="w-24 h-24 rounded-full bg-gradient-to-tr from-blue-600 to-indigo-500 flex items-center justify-center shadow-2xl shadow-blue-500/50 z-10">
            <Sparkles className="w-10 h-10 text-white animate-spin-slow" />
          </div>
        </div>

        <div className="space-y-3">
          <p className="text-xl md:text-2xl font-light text-slate-200 leading-relaxed italic">
            "{transcript || aiTranscript || 'Listening... speak freely.'}"
          </p>
        </div>
      </div>

      {/* Bottom Controls */}
      <div className="w-full max-w-md flex items-center justify-center gap-6 pb-6">
        <button
          onClick={() => setIsMuted(!isMuted)}
          className={`p-5 rounded-full border transition-all ${
            isMuted
              ? 'bg-red-500/20 border-red-500/50 text-red-400'
              : 'bg-slate-800/80 border-slate-700/60 text-slate-200 hover:bg-slate-700'
          } focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none`}
        >
          {isMuted ? <MicOff className="w-7 h-7" /> : <Mic className="w-7 h-7" />}
        </button>

        <button
          onClick={resetVoice}
          className="px-8 py-4 rounded-full bg-red-600 hover:bg-red-700 text-white font-medium shadow-lg shadow-red-600/30 transition-all focus-visible:ring-2 focus-visible:ring-red-500 focus-visible:outline-none"
        >
          End Session
        </button>
      </div>
    </div>
  );
};
