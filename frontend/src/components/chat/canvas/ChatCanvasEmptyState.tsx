import { WeekCard } from './WeekCard';
import React from 'react';
import { Waves, Wind, Anchor, type LucideIcon } from 'lucide-react';
import { SkeletonGreeting, SkeletonMoodChips } from '../../ui/Skeleton';
import { cn } from '../../../utils/ui/cn';

interface ChatCanvasEmptyStateProps {
  greeting: string;
  greetingLoading: boolean;
  onSelectMood?: (text: string) => void;
}

const MOODS: Array<{
  text: string;
  label: string;
  Icon: LucideIcon;
  iconClass: string;
}> = [
  {
    text: 'I feel overwhelmed',
    label: 'I feel overwhelmed',
    Icon: Waves,
    iconClass: 'mood-chip-icon--waves text-brand-secondary',
  },
  {
    text: "I'm feeling anxious",
    label: "I'm feeling anxious",
    Icon: Wind,
    iconClass: 'mood-chip-icon--wind text-brand-accent',
  },
  {
    text: 'I feel stuck',
    label: 'I feel stuck',
    Icon: Anchor,
    iconClass: 'mood-chip-icon--anchor text-feedback-danger',
  },
];

export const ChatCanvasEmptyState: React.FC<ChatCanvasEmptyStateProps> = ({
  greeting,
  greetingLoading,
  onSelectMood,
}) => (
  <div
    id="welcome-screen"
    className={cn(
      'chat-empty relative flex w-full flex-col items-center px-4 pb-8 pt-4 text-center',
      !greetingLoading && 'chat-empty--reveal'
    )}
  >
    <div className="relative w-full max-w-2xl text-center">
      {greetingLoading ? (
        <>
          <SkeletonGreeting />
          <SkeletonMoodChips />
        </>
      ) : (
        <>
          <div className="chat-empty__greeting">
            {/* Fix 9: text-3xl on mobile → text-4xl sm → text-5xl so short-screen
                phones (iPhone SE, Galaxy A) can show the greeting + subtitle + mood chips
                without needing to scroll. */}
            <h1 className="text-3xl sm:text-4xl md:text-5xl font-semibold tracking-tight mb-2 sm:mb-3">
              <span
                id="greeting-text"
                className="bg-clip-text text-transparent bg-brand-gradient"
              >
                {greeting}
              </span>
            </h1>
            <p className="text-lg sm:text-xl md:text-2xl text-content-secondary font-medium tracking-tight mb-4 sm:mb-6">
              What&apos;s on your mind today?
            </p>
          </div>

          <div className="flex flex-wrap justify-center gap-2.5 sm:gap-3">
            {MOODS.map(({ text, label, Icon, iconClass }) => (
              <button
                key={text}
                type="button"
                className="mood-btn mood-chip px-4 py-2.5 rounded-2xl bg-surface-subtle hover:bg-surface-elevated text-sm font-medium text-content-primary flex items-center gap-2 border border-edge-subtle hover:border-edge-default focus-visible:ring-2 focus-visible:ring-brand-primary/40 focus-visible:outline-none select-none"
                aria-label={`Start with: ${label}`}
                onClick={() => onSelectMood?.(text)}
              >
                <Icon className={cn('w-4 h-4', iconClass)} />
                <span>{label}</span>
              </button>
            ))}
          </div>
          <WeekCard onReflect={onSelectMood} />
        </>
      )}
    </div>
  </div>
);
