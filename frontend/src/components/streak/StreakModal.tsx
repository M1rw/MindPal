import React from 'react';
import { X, Flame, Check } from 'lucide-react';
import { useStreakStore } from '../../store';

const DAYS_OF_WEEK = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

export const StreakModal: React.FC = () => {
  const { streak, isOpen, setIsOpen } = useStreakStore();

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
        id="streak-content"
        className="relative bg-white dark:bg-[#1e1f20] w-full max-w-sm flex flex-col rounded-[28px] shadow-2xl overflow-hidden border border-black/5 dark:border-white/10 z-10 animate-fade-in"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100 dark:border-zinc-800">
          <h2 id="streak-modal-title" className="text-base font-semibold text-gray-900 dark:text-gray-100">
            Your Journey
          </h2>
          <button
            onClick={() => setIsOpen(false)}
            className="p-1.5 hover:bg-gray-100 dark:hover:bg-zinc-800 rounded-full text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
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
            <div className="w-20 h-20 rounded-full bg-orange-50 dark:bg-orange-950/30 text-orange-500 flex items-center justify-center mb-4 shadow-sm border border-orange-100 dark:border-orange-800/30">
              <Flame className="w-10 h-10 fill-orange-500 text-orange-500 animate-pulse" />
            </div>
            <div className="text-4xl font-bold text-gray-900 dark:text-white mb-1">
              {streak.count} Day Streak
            </div>
            <div className="text-sm text-gray-500 dark:text-[#c4c7c5]">
              {streak.count > 0
                ? "You're building emotional resilience and clarity."
                : 'Complete a reflection today to begin your streak!'}
            </div>
          </div>

          {/* 7-Day Tracker */}
          <div className="w-full">
            <h3 className="text-[11px] font-bold text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-4 text-center">
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
                          ? 'bg-orange-500 text-white shadow-sm shadow-orange-500/30'
                          : isToday
                          ? 'border-2 border-orange-500 text-orange-500 bg-orange-50/50 dark:bg-orange-950/20'
                          : 'bg-gray-100 dark:bg-zinc-800 text-gray-400 dark:text-gray-500'
                      }`}
                    >
                      {isCompleted ? <Check className="w-4 h-4 stroke-[2.5]" /> : day}
                    </div>
                    <span className="text-[10px] text-gray-400 dark:text-gray-500">
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
