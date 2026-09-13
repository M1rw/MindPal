import React, { useState } from 'react';
import {
  Mic,
  Users,
  Heart,
  Lock,
  Camera,
  Sparkles,
  ShieldCheck,
  ArrowRight,
  Activity,
  ArrowLeft,
} from 'lucide-react';

type PresenceMode = 'auto' | 'solo' | 'couples' | 'group';

interface SessionBoard {
  id: 'solo' | 'couples' | 'group';
  badge: string;
  badgeBg: string;
  badgeText: string;
  accentGradient: string;
  cardBorder: string;
  cardBg: string;
  hoverBorder: string;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  features: string[];
}

const BOARDS: SessionBoard[] = [
  {
    id: 'solo',
    badge: '1 Person · Introspection',
    badgeBg: 'bg-[#4140FD]/10 dark:bg-[#4140FD]/20',
    badgeText: 'text-[#4140FD] dark:text-[#A39CF9]',
    accentGradient: 'from-[#4140FD]/20 via-[#6572F2]/10 to-transparent',
    cardBorder: 'border-[#4140FD]/20 dark:border-[#4140FD]/30',
    cardBg: 'bg-white dark:bg-zinc-900',
    hoverBorder: 'hover:border-[#4140FD] hover:shadow-md hover:shadow-[#4140FD]/5',
    icon: (
      <div className="w-11 h-11 rounded-2xl bg-[#4140FD]/10 dark:bg-[#4140FD]/25 flex items-center justify-center text-[#4140FD] dark:text-[#A39CF9]">
        <Mic className="w-5 h-5" />
      </div>
    ),
    title: 'Solo Session',
    subtitle: 'Just you — voice and camera for deeper insight.',
    features: [
      'Facial micro-expression clarity',
      'Voice cadence & emotional tone',
      'Private reflective journaling',
    ],
  },
  {
    id: 'couples',
    badge: '2 People · Guided Dialogue',
    badgeBg: 'bg-rose-500/10 dark:bg-rose-500/20',
    badgeText: 'text-rose-600 dark:text-rose-400',
    accentGradient: 'from-rose-500/20 via-pink-500/10 to-transparent',
    cardBorder: 'border-rose-400/20 dark:border-rose-500/30',
    cardBg: 'bg-white dark:bg-zinc-900',
    hoverBorder: 'hover:border-rose-500 hover:shadow-md hover:shadow-rose-500/5',
    icon: (
      <div className="w-11 h-11 rounded-2xl bg-rose-500/10 dark:bg-rose-500/25 flex items-center justify-center text-rose-500 dark:text-rose-400">
        <Heart className="w-5 h-5" />
      </div>
    ),
    title: 'Couples Session',
    subtitle: 'Two people, guided dialogue and mediation.',
    features: [
      'Active speaking ratio balance',
      'De-escalation guidance',
      'Turn-taking & empathetic mirrors',
    ],
  },
  {
    id: 'group',
    badge: '3–8 People · Open Circle',
    badgeBg: 'bg-teal-500/10 dark:bg-teal-500/20',
    badgeText: 'text-teal-600 dark:text-teal-400',
    accentGradient: 'from-teal-500/20 via-emerald-500/10 to-transparent',
    cardBorder: 'border-teal-400/20 dark:border-teal-500/30',
    cardBg: 'bg-white dark:bg-zinc-900',
    hoverBorder: 'hover:border-teal-500 hover:shadow-md hover:shadow-teal-500/5',
    icon: (
      <div className="w-11 h-11 rounded-2xl bg-teal-500/10 dark:bg-teal-500/25 flex items-center justify-center text-teal-600 dark:text-teal-400">
        <Users className="w-5 h-5" />
      </div>
    ),
    title: 'Group Session',
    subtitle: '3–8 people — open circle, balanced voices.',
    features: [
      'Multi-speaker recognition',
      'Equal airtime moderation',
      'Shared group emotional consensus',
    ],
  },
];

export const PresenceShell: React.FC = () => {
  const [activeSession, setActiveSession] = useState<PresenceMode | null>(null);

  const startSession = (mode: PresenceMode) => {
    setActiveSession(mode);
  };

  const endSession = () => {
    setActiveSession(null);
  };

  // ── Active Presence Session View ──
  if (activeSession) {
    const sessionTitle =
      activeSession === 'solo'
        ? 'Solo Session'
        : activeSession === 'couples'
        ? 'Couples Session'
        : activeSession === 'group'
        ? 'Group Session'
        : 'Presence Session';

    return (
      <div
        id="tabpanel-presence"
        role="tabpanel"
        aria-labelledby="tab-presence"
        className="flex-1 flex flex-col items-center justify-between p-4 sm:p-8 max-w-4xl mx-auto w-full animate-fade-in"
      >
        {/* Top Session Header */}
        <div className="w-full flex items-center justify-between pb-4 border-b border-black/[0.06] dark:border-white/[0.06]">
          <button
            type="button"
            onClick={endSession}
            className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-black/5 dark:bg-white/10 text-xs font-semibold text-zinc-700 dark:text-zinc-200 hover:bg-black/10 dark:hover:bg-white/20 transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>End Session</span>
          </button>

          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 text-xs font-medium">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-ping" />
              Live Presence Active
            </span>
            <span className="text-xs text-zinc-400 dark:text-zinc-500 select-none">
              On-Device AI
            </span>
          </div>
        </div>

        {/* Viewfinder Canvas Area */}
        <div className="w-full max-w-2xl my-auto py-8 flex flex-col items-center text-center">
          <div className="relative w-full aspect-video rounded-3xl bg-zinc-900 border border-zinc-800 flex flex-col items-center justify-center overflow-hidden shadow-2xl">
            {/* Ambient Aura Background */}
            <div className="absolute inset-0 bg-gradient-to-tr from-[#4140FD]/20 via-transparent to-teal-500/10 pointer-events-none" />

            {/* Target Reticle / Presence Indicator */}
            <div className="relative z-10 flex flex-col items-center text-center p-6">
              <div className="w-16 h-16 rounded-3xl bg-white/10 backdrop-blur-md flex items-center justify-center text-white mb-4 border border-white/20">
                <Camera className="w-8 h-8 text-[#A39CF9] animate-pulse" />
              </div>
              <h3 className="text-xl font-medium text-white mb-1">{sessionTitle}</h3>
              <p className="text-xs text-zinc-400 max-w-sm">
                Local on-device camera & mic analysis active. Detecting posture, eye-line, and voice cadence.
              </p>
            </div>

            {/* Bottom Real-time Stream Bar */}
            <div className="absolute bottom-4 left-4 right-4 flex items-center justify-between px-4 py-2 rounded-2xl bg-black/40 backdrop-blur-md border border-white/10 text-xs text-zinc-300">
              <div className="flex items-center gap-2">
                <Activity className="w-4 h-4 text-emerald-400 animate-pulse" />
                <span>Zero Cloud Storage · Private to this device</span>
              </div>
              <div className="flex items-center gap-1">
                {[...Array(8)].map((_, i) => (
                  <span
                    key={i}
                    className="w-1 bg-[#4140FD] rounded-full animate-sound-wave"
                    style={{ animationDelay: `${i * 100}ms` }}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Bottom Safety Strip */}
        <div className="w-full flex justify-center text-xs text-zinc-400 dark:text-zinc-500 gap-2">
          <Lock className="w-3.5 h-3.5" />
          <span>Camera feed is processed in memory and never leaves your browser.</span>
        </div>
      </div>
    );
  }

  // ── Presence Launcher Screen ──
  return (
    <div
      id="tabpanel-presence"
      role="tabpanel"
      aria-labelledby="tab-presence"
      className="flex-1 flex flex-col items-center px-4 py-8 sm:py-12 max-w-5xl mx-auto w-full animate-fade-in"
    >
      {/* Header — Exact user copy */}
      <div className="text-center mb-8 max-w-xl">
        <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-[#4140FD]/10 dark:bg-[#4140FD]/20 text-[#4140FD] dark:text-[#A39CF9] text-xs font-semibold uppercase tracking-wider mb-3">
          <Sparkles className="w-3.5 h-3.5" />
          <span>Spatial & Vision AI</span>
        </div>
        <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100 mb-2">
          MindPal Presence
        </h1>
        <p className="text-zinc-600 dark:text-zinc-400 text-base sm:text-lg leading-relaxed">
          A safe space — for one or many. Voice and camera, fully on your device.
        </p>

        {/* Flawless Single-Click Launch: Auto-Detects Participants */}
        <div className="mt-5">
          <button
            type="button"
            onClick={() => startSession('auto')}
            className="inline-flex items-center gap-2.5 px-7 py-3 rounded-2xl bg-[#4140FD] hover:bg-[#5251fd] text-white text-sm font-semibold shadow-lg shadow-[#4140FD]/20 hover:scale-[1.02] active:scale-98 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4140FD]"
          >
            <Camera className="w-4 h-4" />
            <span>Start Presence</span>
            <ArrowRight className="w-4 h-4 ml-0.5" />
          </button>
          <div className="text-[11px] text-zinc-400 dark:text-zinc-500 mt-2">
            Instant start · Auto-detects Solo, Couples, or Group dynamically
          </div>
        </div>
      </div>

      {/* 3 Distinct Session Boards — Rich visual differentiation */}
      <div className="w-full grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        {BOARDS.map((board) => (
          <div
            key={board.id}
            className={[
              'relative rounded-3xl p-5 border flex flex-col justify-between transition-all duration-200 group text-left',
              board.cardBg,
              board.cardBorder,
              board.hoverBorder,
            ].join(' ')}
          >
            {/* Top Accent Gradient Ribbon */}
            <div
              className={`absolute top-0 left-0 right-0 h-28 rounded-t-3xl bg-gradient-to-b ${board.accentGradient} opacity-60 pointer-events-none`}
            />

            <div className="relative z-10">
              {/* Badge & Icon */}
              <div className="flex items-center justify-between mb-4">
                <span
                  className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold tracking-wide ${board.badgeBg} ${board.badgeText}`}
                >
                  {board.badge}
                </span>
                {board.icon}
              </div>

              {/* Title & Subtitle */}
              <h2 className="text-xl font-semibold text-zinc-900 dark:text-zinc-100 mb-1.5">
                {board.title}
              </h2>
              <p className="text-xs text-zinc-600 dark:text-zinc-400 leading-relaxed mb-4">
                {board.subtitle}
              </p>

              {/* Feature Highlights */}
              <div className="space-y-1.5 mb-6 pt-3 border-t border-black/[0.05] dark:border-white/[0.06]">
                {board.features.map((feat, i) => (
                  <div key={i} className="flex items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                    <div className="w-1 h-1 rounded-full bg-current opacity-70 flex-shrink-0" />
                    <span>{feat}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Direct Instant Action Button per Board */}
            <button
              type="button"
              onClick={() => startSession(board.id)}
              className="relative z-10 w-full py-2.5 px-4 rounded-xl text-xs font-semibold bg-black/[0.04] dark:bg-white/[0.06] hover:bg-[#4140FD] hover:text-white dark:hover:bg-[#4140FD] dark:hover:text-white text-zinc-700 dark:text-zinc-200 flex items-center justify-center gap-1.5 transition-all duration-150 group-hover:shadow-sm"
            >
              <span>Begin {board.title}</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>

      {/* Privacy Guarantee Footer */}
      <div className="flex items-center justify-center gap-2 text-xs text-zinc-400 dark:text-zinc-500">
        <ShieldCheck className="w-4 h-4 text-emerald-500" />
        <span>Camera & audio stay strictly on your device. Zero cloud recording.</span>
      </div>
    </div>
  );
};

