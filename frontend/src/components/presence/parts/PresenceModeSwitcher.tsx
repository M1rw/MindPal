import React from 'react';
import { HeartHandshake, User, Users } from 'lucide-react';

export type PresenceMode = 'solo' | 'couples' | 'group';
interface PresenceModeSwitcherProps { activeMode: PresenceMode; onChangeMode: (mode: PresenceMode) => void; }

export const PresenceModeSwitcher: React.FC<PresenceModeSwitcherProps> = ({ activeMode, onChangeMode }) => (
  <div className="inline-flex p-1.5 rounded-2xl bg-black/[0.04] dark:bg-white/[0.06] border border-black/[0.04] dark:border-white/[0.08] mb-8 gap-1">
    <ModeButton active={activeMode === 'solo'} onClick={() => onChangeMode('solo')} icon={<User className="w-3.5 h-3.5" />}>Solo Session</ModeButton>
    <ModeButton active={activeMode === 'couples'} onClick={() => onChangeMode('couples')} icon={<HeartHandshake className="w-3.5 h-3.5" />}>Couples Session</ModeButton>
    <ModeButton active={activeMode === 'group'} onClick={() => onChangeMode('group')} icon={<Users className="w-3.5 h-3.5" />}>Group Circle</ModeButton>
  </div>
);

const ModeButton: React.FC<React.PropsWithChildren<{ active: boolean; onClick: () => void; icon: React.ReactNode }>> = ({ active, onClick, icon, children }) => (
  <button type="button" onClick={onClick} className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${active ? 'bg-white dark:bg-[#20202E] text-[#4140FD] dark:text-[#A39CF9] shadow-sm' : 'text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-200'}`}>
    {icon}<span>{children}</span>
  </button>
);
