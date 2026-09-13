import React from 'react';
import { Eye, Lock, Sparkles, Shield, Clock, Compass } from 'lucide-react';

export const PresenceShell: React.FC = () => {
  return (
    <div
      id="tabpanel-presence"
      role="tabpanel"
      aria-labelledby="tab-presence"
      className="flex-1 flex flex-col items-center justify-center px-4 py-12 max-w-2xl mx-auto w-full text-center animate-fade-in my-auto"
    >
      {/* Coming Soon Status Pill */}
      <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#4140FD]/10 dark:bg-[#4140FD]/20 text-[#4140FD] dark:text-[#A39CF9] text-xs font-semibold uppercase tracking-wider mb-5 border border-[#4140FD]/20">
        <Clock className="w-3.5 h-3.5" />
        <span>Coming Soon · In Research</span>
      </div>

      {/* Hero Icon with Ambient Glow */}
      <div className="relative mb-6">
        <div className="absolute inset-0 bg-[#4140FD]/20 dark:bg-[#4140FD]/30 rounded-3xl blur-xl" />
        <div className="relative w-20 h-20 rounded-3xl bg-gemini-surface dark:bg-gemini-darkSurface border border-black/[0.08] dark:border-white/[0.08] flex items-center justify-center shadow-lg mx-auto">
          <Eye className="w-10 h-10 text-[#4140FD] dark:text-[#A39CF9]" />
        </div>
      </div>

      {/* Exact User Copy */}
      <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100 mb-3">
        MindPal Presence
      </h1>
      <p className="text-zinc-600 dark:text-zinc-400 text-base sm:text-lg leading-relaxed max-w-lg mb-8">
        A safe space — for one or many. Voice and camera, fully on your device.
      </p>

      {/* Upcoming Feature Highlights Preview */}
      <div className="w-full bg-gemini-surface dark:bg-gemini-darkSurface rounded-2xl p-5 border border-black/[0.06] dark:border-white/[0.08] mb-8 text-left space-y-3.5">
        <div className="text-xs font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider mb-2">
          In Active Development
        </div>

        <div className="flex items-start gap-3">
          <div className="w-2 h-2 rounded-full bg-[#4140FD] mt-1.5 flex-shrink-0" />
          <div>
            <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Solo Session</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              Just you — voice and camera for deeper insight and reflective inquiry.
            </div>
          </div>
        </div>

        <div className="flex items-start gap-3">
          <div className="w-2 h-2 rounded-full bg-[#6572F2] mt-1.5 flex-shrink-0" />
          <div>
            <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Couples Session</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              Two people, guided dialogue and real-time mediation.
            </div>
          </div>
        </div>

        <div className="flex items-start gap-3">
          <div className="w-2 h-2 rounded-full bg-[#A39CF9] mt-1.5 flex-shrink-0" />
          <div>
            <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Group Session</div>
            <div className="text-xs text-zinc-500 dark:text-zinc-400">
              3–8 people — open circle, balanced voices, and equal airtime.
            </div>
          </div>
        </div>
      </div>

      {/* Privacy Anchor */}
      <div className="flex items-center justify-center gap-2 text-xs text-zinc-400 dark:text-zinc-500">
        <Shield className="w-4 h-4 text-emerald-500" />
        <span>100% on-device vision processing. Zero cloud video storage.</span>
      </div>
    </div>
  );
};


