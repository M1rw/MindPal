import React from 'react';
import { X, Flame, Check } from 'lucide-react';
import { useStreakStore } from '../../store';
import { useFocusTrap } from '../../hooks/useFocusTrap';

const DAYS_OF_WEEK = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

export const StreakModal: React.FC = () => {
  const { streak, isOpen, setIsOpen } = useStreakStore();
  const modalContentRef = useFocusTrap<HTMLDivElement>({
    isOpen,
    onClose: () => setIsOpen(false),
    autoFocus: true,
  });

  if (!isOpen) return null;

  // Calculate current day of week index (Mon=0, Sun=6)
  const currentDayIndex = (new Date().getDay() + 6) % 7;

  return (
    <div
      id="streak-modal"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 animate-fade-in"
      role="dialog"
      aria-modal="true"
      aria-labelledby="streak-modal-title"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/30 dark:bg-black/70 backdrop-blur-sm"
        onClick={() => setIsOpen(false)}
      />

      {/* Content */}
      <div
        ref={modalContentRef}
        id="streak-content"
        className="relative bg-surface-card w-full max-w-sm flex flex-col rounded-2xl specular-card shadow-modal overflow-hidden border border-edge-subtle z-10 animate-fade-in"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-edge-subtle">
          <h2 id="streak-modal-title" className="text-base font-semibold text-content-primary">
            Your Journey
          </h2>
          <button
            onClick={() => setIsOpen(false)}
            className="p-1.5 hover:bg-surface-subtle rounded-full text-content-muted hover:text-content-primary transition-colors focus-visible:ring-2 focus-visible:ring-brand-primary focus-visible:outline-none"
            title="Close progress modal"
            aria-label="Close progress view"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Body */}
        <div className="p-8 flex flex-col items-center gap-8">
          {/* Flame & Count */}
          <div className="flex flex-col items-center text-center">
            <div className="w-20 h-20 rounded-full bg-orange-50 dark:bg-orange-950/30 text-orange-500 flex items-center justify-center mb-4 border border-orange-200 dark:border-orange-800/30 shadow-[0_0_24px_rgba(249,115,22,0.18)]">
              <Flame className="w-10 h-10 fill-orange-500 text-orange-500 animate-pulse" />
            </div>
            <div className="text-4xl font-bold text-content-primary mb-1">
              {streak.count} Day Streak
            </div>
            <div className="text-sm text-content-secondary">
              {streak.count > 0
                ? "You're building emotional resilience and clarity."
                : 'Complete a reflection today to begin your streak!'}
            </div>
          </div>

          {/* 7-Day Tracker */}
          <div className="w-full">
            <h3 className="text-2xs font-bold text-content-muted uppercase tracking-wider mb-4 text-center">
              Weekly Progress
            </h3>
            <div className="flex justify-between items-center w-full px-2" id="weekly-tracker">
              {DAYS_OF_WEEK.map((day, idx) => {
                const isCompleted = streak.weeklyDays[idx];
                const isToday = idx === currentDayIndex;

                return (
                  <div key={idx} className="flex flex-col items-center gap-1.5">
                    <div
                      className={`w-9 h-9 rounded-full flex items-center justify-center text-xs font-semibold transition-all ${
                        isCompleted
                          ? 'bg-orange-500 text-white shadow-sm'
                          : isToday
                          ? 'border-2 border-orange-500 text-orange-500 bg-orange-50/50 dark:bg-orange-950/20'
                          : 'bg-surface-subtle text-content-muted'
                      }`}
                    >
                      {isCompleted ? <Check className="w-4 h-4 stroke-[2.5]" /> : day}
                    </div>
                    <span className="text-2xs text-content-muted">
                      {isToday ? 'Today' : day}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
