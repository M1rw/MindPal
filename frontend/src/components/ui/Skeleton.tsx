import React from 'react';

export interface SkeletonProps extends React.HTMLAttributes<HTMLDivElement> {
  className?: string;
}

/**
 * Base Tier-1 Shimmer Skeleton.
 * Employs a continuous smooth linear specular gradient sweep across light and dark modes.
 */
export const Skeleton: React.FC<SkeletonProps> = ({ className = '', style, ...props }) => {
  return (
    <div
      aria-hidden="true"
      className={`bg-shimmer-gradient bg-[length:200%_100%] animate-shimmer rounded-lg pointer-events-none select-none ${className}`}
      style={style}
      {...props}
    />
  );
};

/**
 * Shimmer placeholder for the Empty State Greeting text.
 */
export const SkeletonGreeting: React.FC = () => {
  return (
    <div className="flex flex-col items-center justify-center gap-2 mb-6" aria-hidden="true">
      <Skeleton className="h-11 sm:h-14 w-60 sm:w-80 rounded-2xl" />
      <Skeleton className="h-7 sm:h-9 w-72 sm:w-96 rounded-xl mt-1 opacity-75" />
    </div>
  );
};

/** Mood-chip sized placeholders that sit in the same row as the real chips. */
export const SkeletonMoodChips: React.FC = () => {
  return (
    <div className="flex flex-wrap justify-center gap-2.5 sm:gap-3" aria-hidden="true">
      <Skeleton className="h-10 w-[11.5rem] rounded-2xl" />
      <Skeleton className="h-10 w-[12.25rem] rounded-2xl" />
      <Skeleton className="h-10 w-[9.5rem] rounded-2xl" />
    </div>
  );
};

/**
 * Staggered Shimmer Rows for Chat History Modal (Cloud Syncing).
 */
export const SkeletonHistoryList: React.FC<{ count?: number }> = ({ count = 4 }) => {
  return (
    <div className="py-2 px-3 space-y-2.5" aria-hidden="true">
      <div className="px-2 pt-1 pb-1">
        <Skeleton className="h-3 w-16 rounded" />
      </div>
      {Array.from({ length: count }).map((_, idx) => (
        <div
          key={idx}
          className="flex items-center gap-3 px-3 py-2.5 rounded-xl border border-edge-subtle bg-surface-subtle/50"
          style={{ animationDelay: `${idx * 80}ms` }}
        >
          <Skeleton className="w-7 h-7 rounded-lg flex-shrink-0" />
          <div className="flex-1 min-w-0 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Skeleton className={`h-3.5 rounded ${idx % 2 === 0 ? 'w-36' : 'w-48'}`} />
              <Skeleton className="h-3 w-10 rounded flex-shrink-0" />
            </div>
            <Skeleton className={`h-2.5 rounded opacity-70 ${idx % 2 === 0 ? 'w-52' : 'w-40'}`} />
          </div>
        </div>
      ))}
    </div>
  );
};

/**
 * Shimmer card for Memory Inspector (Summary & Atoms).
 */
export const SkeletonMemoryView: React.FC<{ mode?: 'summary' | 'atoms' }> = ({ mode = 'summary' }) => {
  if (mode === 'summary') {
    return (
      <div className="space-y-3.5 py-2" aria-hidden="true">
        <Skeleton className="h-4 w-11/12 rounded" />
        <Skeleton className="h-4 w-full rounded" />
        <Skeleton className="h-4 w-4/5 rounded" />
        <Skeleton className="h-4 w-5/6 rounded" />
        <Skeleton className="h-4 w-3/5 rounded opacity-80" />
      </div>
    );
  }

  return (
    <div className="space-y-0 py-1" aria-hidden="true">
      {Array.from({ length: 3 }).map((_, idx) => (
        <div
          key={idx}
          className="flex items-center justify-between gap-3 border-b border-edge-subtle py-2"
          style={{ animationDelay: `${idx * 100}ms` }}
        >
          <div className="min-w-0 flex-1 space-y-1">
            <Skeleton className="h-3 w-14 rounded" />
            <Skeleton className={`h-3.5 rounded ${idx % 2 === 0 ? 'w-3/4' : 'w-2/3'}`} />
          </div>
          <div className="flex gap-1">
            <Skeleton className="h-8 w-8 rounded-full" />
            <Skeleton className="h-8 w-8 rounded-full" />
          </div>
        </div>
      ))}
    </div>
  );
};
