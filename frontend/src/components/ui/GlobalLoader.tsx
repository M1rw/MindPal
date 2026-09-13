import React, { useEffect, useRef, useState } from 'react';

const PHRASES = ['Hello.', 'Getting things ready…', 'Almost there…'];

export const GlobalLoader: React.FC = () => {
  const [displayText, setDisplayText] = useState('');
  const [visible, setVisible] = useState(true);
  const phraseIndexRef = useRef(0);
  const charIndexRef = useRef(0);

  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout>;

    const type = () => {
      const phrase = PHRASES[phraseIndexRef.current];
      if (charIndexRef.current <= phrase.length) {
        setDisplayText(phrase.slice(0, charIndexRef.current));
        charIndexRef.current++;
        timeoutId = setTimeout(type, 70);
      } else {
        // Pause then fade to next phrase
        timeoutId = setTimeout(() => {
          if (phraseIndexRef.current >= PHRASES.length - 1) return;
          setVisible(false);
          timeoutId = setTimeout(() => {
            phraseIndexRef.current++;
            charIndexRef.current = 0;
            setVisible(true);
            timeoutId = setTimeout(type, 100);
          }, 400);
        }, 1800);
      }
    };

    timeoutId = setTimeout(type, 300);
    return () => clearTimeout(timeoutId);
  }, []);

  return (
    <div
      id="global-loader"
      className="fixed inset-0 z-[999] bg-gemini-bg dark:bg-gemini-darkBg transition-opacity duration-700 ease-in-out flex flex-col pointer-events-none"
    >
      {/* Header skeleton */}
      <div className="flex items-center justify-between px-6 py-4 flex-none w-full">
        <div className="flex items-center gap-2">
          <div className="w-[72px] h-6 bg-gray-200/70 dark:bg-zinc-800 rounded-md animate-pulse" />
          <div className="w-10 h-5 bg-gemini-surface dark:bg-gemini-darkSurface rounded-md animate-pulse" style={{ animationDelay: '80ms' }} />
        </div>
        <div className="flex items-center gap-2">
          <div className="w-9 h-9 rounded-full bg-gray-100 dark:bg-zinc-800/60 animate-pulse" style={{ animationDelay: '120ms' }} />
          <div className="w-14 h-8 rounded-full bg-gray-100 dark:bg-zinc-800/60 animate-pulse" style={{ animationDelay: '160ms' }} />
          <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-zinc-700 animate-pulse border border-gray-300/50 dark:border-zinc-600/50" style={{ animationDelay: '200ms' }} />
        </div>
      </div>

      {/* Center — gradient typewriter */}
      <div className="flex-1 flex items-center justify-center">
        <h1 className="text-3xl sm:text-4xl md:text-5xl font-medium tracking-tight">
          <span
            className="bg-clip-text text-transparent bg-gradient-to-r from-[#4285f4] via-[#9b72cb] to-[#d96570] transition-opacity duration-300"
            style={{ opacity: visible ? 1 : 0 }}
          >
            {displayText}
          </span>
        </h1>
      </div>

      {/* Composer skeleton */}
      <div className="w-full pb-6 px-4 flex justify-center flex-none">
        <div className="w-full max-w-4xl">
          <div className="bg-gemini-surface dark:bg-gemini-darkSurface rounded-[32px] p-2 flex items-center w-full">
            <div className="flex-1 h-5 bg-gray-300/30 dark:bg-zinc-700/40 rounded-md animate-pulse ml-4 max-w-[140px] sm:max-w-[180px]" style={{ animationDelay: '300ms' }} />
            <div className="flex items-center gap-1.5 pr-1 ml-auto">
              <div className="w-36 h-8 rounded-xl bg-gray-200/40 dark:bg-zinc-700/30 animate-pulse" style={{ animationDelay: '350ms' }} />
              <div className="w-10 h-10 rounded-full bg-gray-200/40 dark:bg-zinc-700/30 animate-pulse" style={{ animationDelay: '400ms' }} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
