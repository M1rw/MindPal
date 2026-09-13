import React, { useEffect, useRef, useState } from 'react';
import { Waves, Wind, Anchor, Copy, Check } from 'lucide-react';
import { useChatStore, useAuthStore } from '../../store';
import { renderMarkdown } from '../../utils/markdown';
import { useGreeting } from '../../hooks/useGreeting';

interface ChatCanvasProps {
  onSelectMood?: (text: string) => void;
  children?: React.ReactNode;
}

export const ChatCanvas: React.FC<ChatCanvasProps> = ({ onSelectMood, children }) => {
  const { messages, isGenerating } = useChatStore();
  const { user } = useAuthStore();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const { greeting, isLoading: greetingLoading } = useGreeting(user ? { uid: user.uid, displayName: user.displayName } : null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isGenerating]);

  const copyToClipboard = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  // greeting + isLoading provided by useGreeting hook above

  return (
    <div
      id="chat-canvas"
      className="flex-1 overflow-y-auto px-4 py-6 md:px-8 max-w-4xl mx-auto w-full space-y-6 pt-20 custom-scrollbar flex flex-col"
    >
      {messages.length === 0 ? (
        /* Empty State: Centered Greeting, Starter Chips & Centered Input Box */
        <div className="flex-1 flex flex-col items-center justify-center text-center px-4 animate-fade-in my-auto">
          <div className="w-full max-w-2xl text-center mb-8">
            <h1 className="text-4xl sm:text-5xl font-medium tracking-tight mb-2">
              {greetingLoading ? (
                <span className="inline-block h-12 w-64 rounded-xl bg-zinc-200 dark:bg-zinc-800 animate-pulse" aria-hidden="true" />
              ) : (
                <span
                  id="greeting-text"
                  className="bg-clip-text text-transparent bg-gradient-to-r from-[#A39CF9] via-[#6572F2] to-[#4140FD] animate-fade-in"
                >
                  {greeting}
                </span>
              )}
            </h1>
            <p className="text-2xl sm:text-3xl text-zinc-600 dark:text-zinc-300 font-medium tracking-tight mb-8">
              What's on your mind today?
            </p>

            {/* Quick Mood Starter Chips */}
            <div className="flex flex-wrap justify-center gap-2.5 sm:gap-3 mb-8">
              <button
                type="button"
                onClick={() => onSelectMood?.('I feel overwhelmed')}
                className="px-4 py-2.5 rounded-xl bg-gemini-surface dark:bg-gemini-darkSurface hover:bg-black/[0.04] dark:hover:bg-white/[0.06] text-sm font-medium text-zinc-700 dark:text-zinc-200 flex items-center gap-2 border border-black/[0.06] dark:border-white/[0.08] hover:border-black/15 dark:hover:border-white/15 transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none select-none"
              >
                <Waves className="w-4 h-4 text-[#4140FD]" />
                <span>I feel overwhelmed</span>
              </button>

              <button
                type="button"
                onClick={() => onSelectMood?.("I'm feeling anxious")}
                className="px-4 py-2.5 rounded-xl bg-gemini-surface dark:bg-gemini-darkSurface hover:bg-black/[0.04] dark:hover:bg-white/[0.06] text-sm font-medium text-zinc-700 dark:text-zinc-200 flex items-center gap-2 border border-black/[0.06] dark:border-white/[0.08] hover:border-black/15 dark:hover:border-white/15 transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none select-none"
              >
                <Wind className="w-4 h-4 text-[#6572F2]" />
                <span>I'm feeling anxious</span>
              </button>

              <button
                type="button"
                onClick={() => onSelectMood?.('I feel stuck')}
                className="px-4 py-2.5 rounded-xl bg-gemini-surface dark:bg-gemini-darkSurface hover:bg-black/[0.04] dark:hover:bg-white/[0.06] text-sm font-medium text-zinc-700 dark:text-zinc-200 flex items-center gap-2 border border-black/[0.06] dark:border-white/[0.08] hover:border-black/15 dark:hover:border-white/15 transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none select-none"
              >
                <Anchor className="w-4 h-4 text-[#A39CF9]" />
                <span>I feel stuck</span>
              </button>
            </div>
          </div>

          {/* Centered Composer Container when empty */}
          <div className="w-full max-w-3xl">
            {children}
          </div>
        </div>
      ) : (
        /* Conversation Messages — Clean Tier-1 Stream without Avatars */
        <div className="space-y-6 flex-1">
          {messages.map((msg) => {
            const isUser = msg.role === 'user';
            const htmlContent = renderMarkdown(msg.content);

            return (
              <div
                key={msg.id}
                className={`flex ${isUser ? 'justify-end' : 'justify-start'} group animate-fade-in`}
              >
                <div
                  className={`flex flex-col max-w-[88%] sm:max-w-[80%] ${
                    isUser ? 'items-end' : 'items-start'
                  }`}
                >
                  <div
                    className={`rounded-2xl px-5 py-3.5 text-[15px] leading-relaxed transition-colors ${
                      isUser
                        ? 'bg-[#4140FD] text-white rounded-tr-sm'
                        : 'bg-gemini-surface dark:bg-gemini-darkSurface text-zinc-900 dark:text-zinc-100 rounded-tl-sm border border-black/[0.04] dark:border-white/[0.06]'
                    }`}
                    dangerouslySetInnerHTML={{ __html: htmlContent }}
                  />

                  {/* Assistant Metadata & Controls */}
                  {!isUser && (
                    <div className="flex items-center gap-2 mt-1.5 px-1 text-xs text-zinc-400 dark:text-zinc-500">
                      {msg.strategy_used && (
                        <span className="bg-black/5 dark:bg-white/5 px-2 py-0.5 rounded-md text-[11px] font-medium text-zinc-600 dark:text-zinc-400 border border-black/[0.04] dark:border-white/[0.06]">
                          {msg.strategy_used}
                        </span>
                      )}
                      <button
                        onClick={() => copyToClipboard(msg.id, msg.content)}
                        className="p-1 rounded-md hover:bg-black/5 dark:hover:bg-white/10 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none"
                        title="Copy response"
                        aria-label="Copy response"
                      >
                        {copiedId === msg.id ? (
                          <Check className="w-3.5 h-3.5 text-green-500" />
                        ) : (
                          <Copy className="w-3.5 h-3.5" />
                        )}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}

          {/* Generating pulse indicator */}
          {isGenerating && (
            <div className="flex justify-start animate-fade-in">
              <div className="bg-gemini-surface dark:bg-gemini-darkSurface rounded-2xl rounded-tl-sm px-5 py-4 border border-black/[0.04] dark:border-white/[0.06] flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full bg-[#4140FD] animate-bounce" style={{ animationDelay: '0ms' }} />
                <div className="w-2 h-2 rounded-full bg-[#6572F2] animate-bounce" style={{ animationDelay: '150ms' }} />
                <div className="w-2 h-2 rounded-full bg-[#A39CF9] animate-bounce" style={{ animationDelay: '300ms' }} />
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
};
