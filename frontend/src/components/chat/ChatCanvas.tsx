import React, { useEffect, useRef, useState } from 'react';
import { Waves, Wind, Anchor, Copy, Check, Volume2, ThumbsUp, ThumbsDown, RefreshCw } from 'lucide-react';
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
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const { greeting, isLoading: greetingLoading } = useGreeting(user ? { uid: user.uid, displayName: user.displayName } : null);

  // Smooth scroll on new messages
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isGenerating]);

  const copyToClipboard = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div
      id="chat-canvas"
      ref={scrollRef}
      className="flex-1 overflow-y-auto custom-scrollbar flex flex-col"
    >
      {messages.length === 0 ? (
        /* Empty State — centered, slides up when chat starts */
        <div className="flex-1 flex flex-col items-center justify-center text-center px-4 animate-fade-in my-auto -translate-y-6 sm:-translate-y-8">
          <div className="w-full max-w-2xl text-center mb-6">
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
            <p className="text-2xl sm:text-3xl text-zinc-600 dark:text-zinc-300 font-medium tracking-tight mb-6">
              What&apos;s on your mind today?
            </p>

            {/* Quick Mood Starter Chips */}
            <div className="flex flex-wrap justify-center gap-2.5 sm:gap-3 mb-6">
              <button
                type="button"
                onClick={() => onSelectMood?.('I feel overwhelmed')}
                className="px-4 py-2.5 rounded-2xl bg-[#f0f4f9] dark:bg-gemini-darkSurface hover:bg-black/[0.06] dark:hover:bg-white/[0.08] text-sm font-medium text-zinc-700 dark:text-zinc-200 flex items-center gap-2 transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none select-none"
              >
                <Waves className="w-4 h-4 text-[#2563EB] dark:text-[#3B82F6]" />
                <span>I feel overwhelmed</span>
              </button>

              <button
                type="button"
                onClick={() => onSelectMood?.("I'm feeling anxious")}
                className="px-4 py-2.5 rounded-2xl bg-[#f0f4f9] dark:bg-gemini-darkSurface hover:bg-black/[0.06] dark:hover:bg-white/[0.08] text-sm font-medium text-zinc-700 dark:text-zinc-200 flex items-center gap-2 transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none select-none"
              >
                <Wind className="w-4 h-4 text-[#9333EA] dark:text-[#A855F7]" />
                <span>I&apos;m feeling anxious</span>
              </button>

              <button
                type="button"
                onClick={() => onSelectMood?.('I feel stuck')}
                className="px-4 py-2.5 rounded-2xl bg-[#f0f4f9] dark:bg-gemini-darkSurface hover:bg-black/[0.06] dark:hover:bg-white/[0.08] text-sm font-medium text-zinc-700 dark:text-zinc-200 flex items-center gap-2 transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none select-none"
              >
                <Anchor className="w-4 h-4 text-[#E11D48] dark:text-[#FB7185]" />
                <span>I feel stuck</span>
              </button>
            </div>
          </div>

          {/* Centered Composer */}
          <div className="w-full max-w-3xl">
            {children}
          </div>
        </div>
      ) : (
        /* ── Conversation Thread ── */
        <div className="flex-1 py-6 px-4 md:px-0 max-w-3xl w-full mx-auto">
          <div className="space-y-1">
            {messages.map((msg, idx) => {
              const isUser = msg.role === 'user';
              const htmlContent = renderMarkdown(msg.content);
              const isLast = idx === messages.length - 1;
              const isStreaming = isLast && isGenerating && !isUser;

              return (
                <div
                  key={msg.id}
                  className={`flex ${isUser ? 'justify-end' : 'justify-start'} animate-msg-in`}
                  style={{ animationDelay: `${Math.min(idx * 20, 120)}ms` }}
                >
                  <div
                    className={`flex flex-col ${isUser ? 'items-end max-w-[78%]' : 'items-start w-full'}`}
                  >
                    {isUser ? (
                      /* User bubble — pill shaped, brand bg */
                      <div className="px-4 py-2.5 rounded-[20px] bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 text-[15px] leading-relaxed font-normal">
                        {msg.content}
                      </div>
                    ) : (
                      /* Assistant — no background, clean prose */
                      <div className="w-full group">
                        <div
                          className={`text-[15px] leading-[1.75] text-zinc-800 dark:text-zinc-100 prose prose-sm dark:prose-invert max-w-none prose-p:my-1.5 prose-headings:mb-2 prose-headings:mt-4 prose-li:my-0.5 ${isStreaming ? 'streaming-text' : ''}`}
                          dangerouslySetInnerHTML={{ __html: htmlContent }}
                        />

                        {/* Action row — only show when not streaming */}
                        {!isStreaming && msg.content && (
                          <div className="flex items-center gap-0.5 mt-2 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                            <button
                              onClick={() => copyToClipboard(msg.id, msg.content)}
                              className="msg-action-btn p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
                              title="Copy"
                              aria-label="Copy response"
                            >
                              {copiedId === msg.id ? (
                                <Check className="w-3.5 h-3.5 text-green-500" />
                              ) : (
                                <Copy className="w-3.5 h-3.5" />
                              )}
                            </button>
                            <button
                              className="msg-action-btn p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
                              title="Read aloud"
                              aria-label="Read aloud"
                            >
                              <Volume2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              className="msg-action-btn p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
                              title="Good response"
                              aria-label="Thumbs up"
                            >
                              <ThumbsUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                              className="msg-action-btn p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
                              title="Bad response"
                              aria-label="Thumbs down"
                            >
                              <ThumbsDown className="w-3.5 h-3.5" />
                            </button>
                            <button
                              className="msg-action-btn p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-zinc-800 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
                              title="Regenerate"
                              aria-label="Regenerate response"
                            >
                              <RefreshCw className="w-3.5 h-3.5" />
                            </button>
                            {msg.strategy_used && (
                              <span className="ml-1 text-[10px] text-zinc-400 dark:text-zinc-500 font-medium">
                                {msg.strategy_used}
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Generating indicator */}
            {isGenerating && messages[messages.length - 1]?.content === '' && (
              <div className="flex justify-start animate-fade-in pt-1">
                <div className="flex items-center gap-1 py-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 dark:bg-zinc-500 animate-bounce" style={{ animationDelay: '0ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 dark:bg-zinc-500 animate-bounce" style={{ animationDelay: '120ms' }} />
                  <span className="w-1.5 h-1.5 rounded-full bg-zinc-400 dark:bg-zinc-500 animate-bounce" style={{ animationDelay: '240ms' }} />
                </div>
              </div>
            )}
          </div>

          <div ref={bottomRef} className="h-6" />
        </div>
      )}
    </div>
  );
};
