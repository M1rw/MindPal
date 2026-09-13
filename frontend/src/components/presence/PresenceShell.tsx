import React from 'react';
import { Mic, Users, Heart, Lock } from 'lucide-react';

type PresenceMode = 'solo' | 'couples' | 'group';

const MODES: { id: PresenceMode; icon: React.ReactNode; title: string; description: string; delay: string }[] = [
  {
    id: 'solo',
    icon: <Mic className="w-5 h-5 text-[#4140FD]" />,
    title: 'Solo Session',
    description: 'Just you — voice and camera for deeper insight.',
    delay: '0ms',
  },
  {
    id: 'couples',
    icon: <Heart className="w-5 h-5 text-[#6572F2]" />,
    title: 'Couples Session',
    description: 'Two people, guided dialogue and mediation.',
    delay: '60ms',
  },
  {
    id: 'group',
    icon: <Users className="w-5 h-5 text-[#A39CF9]" />,
    title: 'Group Session',
    description: '3–8 people — open circle, balanced voices.',
    delay: '120ms',
  },
];

export const PresenceShell: React.FC = () => {
  const [selected, setSelected] = React.useState<PresenceMode | null>(null);

  return (
    <div
      id="tabpanel-presence"
      role="tabpanel"
      aria-labelledby="tab-presence"
      className="flex-1 flex flex-col items-center justify-center px-4 py-12 animate-fade-in"
    >
      {/* Header */}
      <div className="text-center mb-10 max-w-md">
        <div className="w-14 h-14 rounded-2xl bg-[#4140FD]/10 dark:bg-[#4140FD]/20 flex items-center justify-center mx-auto mb-4">
          <span className="text-2xl">👁</span>
        </div>
        <h2 className="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-100 mb-2">
          MindPal Presence
        </h2>
        <p className="text-zinc-500 dark:text-zinc-400 text-base leading-relaxed">
          A safe space — for one or many. Voice and camera, fully on your device.
        </p>
      </div>

      {/* Mode Cards */}
      <div className="w-full max-w-sm space-y-3 mb-8">
        {MODES.map((mode) => (
          <button
            key={mode.id}
            type="button"
            onClick={() => setSelected(mode.id)}
            style={{ animationDelay: mode.delay }}
            className={[
              'w-full flex items-center gap-4 px-4 py-3.5 rounded-2xl border text-left',
              'transition-all duration-150 animate-fade-in focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4140FD]',
              selected === mode.id
                ? 'border-[#4140FD] bg-[#4140FD]/5 dark:bg-[#4140FD]/10'
                : 'border-black/[0.07] dark:border-white/[0.08] bg-white dark:bg-zinc-900 hover:border-[#6572F2]/50 hover:bg-[#4140FD]/[0.03]',
            ].join(' ')}
            aria-pressed={selected === mode.id}
          >
            <div className="w-9 h-9 rounded-xl bg-zinc-100 dark:bg-zinc-800 flex items-center justify-center flex-shrink-0">
              {mode.icon}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{mode.title}</div>
              <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 truncate">{mode.description}</div>
            </div>
            {selected === mode.id && (
              <div className="w-2 h-2 rounded-full bg-[#4140FD] flex-shrink-0" />
            )}
          </button>
        ))}
      </div>

      {/* CTA */}
      <button
        type="button"
        disabled={!selected}
        className={[
          'px-8 py-3 rounded-xl text-sm font-semibold transition-all duration-200',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#4140FD]',
          selected
            ? 'bg-[#4140FD] hover:bg-[#5251fd] text-white hover:scale-[1.02] active:scale-95'
            : 'bg-black/5 dark:bg-white/5 text-zinc-400 cursor-not-allowed',
        ].join(' ')}
      >
        Begin Session →
      </button>

      {/* Privacy strip */}
      <div className="flex items-center gap-1.5 mt-6 text-[12px] text-zinc-400 dark:text-zinc-500">
        <Lock className="w-3 h-3" />
        <span>Camera stays on your device. Nothing is recorded.</span>
      </div>
    </div>
  );
};
