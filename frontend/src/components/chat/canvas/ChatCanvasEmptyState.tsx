import React from 'react';
import { Waves, Wind, Anchor } from 'lucide-react';
import { SkeletonGreeting } from '../../ui/Skeleton';

interface ChatCanvasEmptyStateProps {
  greeting: string;
  greetingLoading: boolean;
  onSelectMood?: (text: string) => void;
  children?: React.ReactNode;
}

export const ChatCanvasEmptyState: React.FC<ChatCanvasEmptyStateProps> = ({
  greeting,
  greetingLoading,
  onSelectMood,
  children,
}) => (
  <div className="relative flex-1 flex flex-col items-center justify-center text-center px-4 animate-fade-in my-auto -translate-y-6 sm:-translate-y-8">
    <div className="ambient-canvas-glow" aria-hidden="true" />

    <div className="relative w-full max-w-2xl text-center mb-6 z-10">
      {greetingLoading ? (
        <SkeletonGreeting />
      ) : (
        <>
          <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight mb-2">
            <span
              id="greeting-text"
              className="bg-clip-text text-transparent bg-brand-gradient animate-fade-in"
            >
              {greeting}
            </span>
          </h1>
          <p className="text-2xl sm:text-3xl text-content-secondary font-medium tracking-tight mb-6">
            What&apos;s on your mind today?
          </p>
        </>
      )}

      <div className="flex flex-wrap justify-center gap-2.5 sm:gap-3 mb-6">
        <button
          type="button"
          onClick={() => onSelectMood?.('I feel overwhelmed')}
          className="animate-mood-chip px-4 py-2.5 rounded-2xl bg-surface-subtle hover:bg-surface-elevated text-sm font-medium text-content-primary flex items-center gap-2 border border-edge-subtle hover:border-edge-default transition-all duration-150 hover:-translate-y-0.5 hover:shadow-card active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-brand-primary/40 focus-visible:outline-none select-none"
          style={{ animationDelay: '0ms' }}
        >
          <Waves className="w-4 h-4 text-blue-500 dark:text-blue-400" />
          <span>I feel overwhelmed</span>
        </button>

        <button
          type="button"
          onClick={() => onSelectMood?.("I'm feeling anxious")}
          className="animate-mood-chip px-4 py-2.5 rounded-2xl bg-surface-subtle hover:bg-surface-elevated text-sm font-medium text-content-primary flex items-center gap-2 border border-edge-subtle hover:border-edge-default transition-all duration-150 hover:-translate-y-0.5 hover:shadow-card active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-brand-primary/40 focus-visible:outline-none select-none"
          style={{ animationDelay: '75ms' }}
        >
          <Wind className="w-4 h-4 text-purple-500 dark:text-purple-400" />
          <span>I&apos;m feeling anxious</span>
        </button>

        <button
          type="button"
          onClick={() => onSelectMood?.('I feel stuck')}
          className="animate-mood-chip px-4 py-2.5 rounded-2xl bg-surface-subtle hover:bg-surface-elevated text-sm font-medium text-content-primary flex items-center gap-2 border border-edge-subtle hover:border-edge-default transition-all duration-150 hover:-translate-y-0.5 hover:shadow-card active:scale-[0.97] focus-visible:ring-2 focus-visible:ring-brand-primary/40 focus-visible:outline-none select-none"
          style={{ animationDelay: '150ms' }}
        >
          <Anchor className="w-4 h-4 text-rose-500 dark:text-rose-400" />
          <span>I feel stuck</span>
        </button>
      </div>
    </div>

    <div className="relative w-full max-w-3xl z-10">{children}</div>
  </div>
);
