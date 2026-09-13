import React, { useEffect, useRef, useState } from 'react';
import { Bot, User, Waves, Wind, Anchor, Copy, Check, Sparkles } from 'lucide-react';
import { useChatStore, useAuthStore } from '../../store';
import { renderMarkdown } from '../../utils/markdown';

interface ChatCanvasProps {
  onSelectMood?: (text: string) => void;
}

export const ChatCanvas: React.FC<ChatCanvasProps> = ({ onSelectMood }) => {
  const { messages, isGenerating } = useChatStore();
  const { user } = useAuthStore();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isGenerating]);

  const copyToClipboard = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const getGreeting = () => {
    if (user?.displayName) {
      const firstName = user.displayName.trim().split(' ')[0];
      return `Hello, ${firstName}.`;
    }
    return 'Hello.';
  };

  return (
    <div
      id="chat-canvas"
      className="flex-1 overflow-y-auto px-4 py-6 md:px-8 max-w-4xl mx-auto w-full space-y-6 pt-20 custom-scrollbar"
    >
      {messages.length === 0 ? (
        /* Gemini Gradient Welcome Screen */
        <div className="min-h-[60vh] flex flex-col items-center justify-center text-center px-4 animate-fade-in">
          <div className="w-full max-w-2xl text-left sm:text-center mb-8">
            <h1 className="text-4xl sm:text-5xl font-medium tracking-tight mb-2">
              <span
                id="greeting-text"
                className="bg-clip-text text-transparent bg-gradient-to-r from-[#4285f4] via-[#9b72cb] to-[#d96570]"
              >
                {getGreeting()}
              </span>
            </h1>
            <p className="text-2xl sm:text-3xl text-[#444746] dark:text-[#c4c7c5] font-medium tracking-tight mb-8">
              What's on your mind today?
            </p>

            {/* Quick Mood Starter Chips */}
            <div className="flex flex-wrap justify-start sm:justify-center gap-3">
              <button
                type="button"
                onClick={() => onSelectMood?.('I feel overwhelmed')}
                className="px-4 py-3 rounded-2xl bg-gemini-surface dark:bg-gemini-darkSurface hover:bg-gray-200 dark:hover:bg-zinc-800 transition-all duration-200 text-sm font-medium text-gray-700 dark:text-gray-300 shadow-sm flex items-center gap-2 hover:scale-[1.02] active:scale-95 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
                aria-label="Start reflection: I feel overwhelmed"
              >
                <Waves className="w-4 h-4 text-blue-500" />
                <span>I feel overwhelmed</span>
              </button>

              <button
                type="button"
                onClick={() => onSelectMood?.("I'm feeling anxious")}
                className="px-4 py-3 rounded-2xl bg-gemini-surface dark:bg-gemini-darkSurface hover:bg-gray-200 dark:hover:bg-zinc-800 transition-all duration-200 text-sm font-medium text-gray-700 dark:text-gray-300 shadow-sm flex items-center gap-2 hover:scale-[1.02] active:scale-95 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
                aria-label="Start reflection: I'm feeling anxious"
              >
                <Wind className="w-4 h-4 text-purple-500" />
                <span>I'm feeling anxious</span>
              </button>

              <button
                type="button"
                onClick={() => onSelectMood?.('I feel stuck')}
                className="px-4 py-3 rounded-2xl bg-gemini-surface dark:bg-gemini-darkSurface hover:bg-gray-200 dark:hover:bg-zinc-800 transition-all duration-200 text-sm font-medium text-gray-700 dark:text-gray-300 shadow-sm flex items-center gap-2 hover:scale-[1.02] active:scale-95 focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
                aria-label="Start reflection: I feel stuck"
              >
                <Anchor className="w-4 h-4 text-rose-500" />
                <span>I feel stuck</span>
              </button>
            </div>
          </div>
        </div>
      ) : (
        /* Conversation Messages */
        messages.map((msg) => {
          const isUser = msg.role === 'user';
          const htmlContent = renderMarkdown(msg.content);

          return (
            <div
              key={msg.id}
              className={`flex gap-3.5 ${isUser ? 'flex-row-reverse' : 'flex-row'} items-start group animate-fade-in`}
            >
              {/* Avatar */}
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-xs font-semibold ${
                  isUser
                    ? 'bg-blue-600 text-white'
                    : 'bg-gemini-surface dark:bg-gemini-darkSurface text-blue-500 border border-black/5 dark:border-white/10'
                }`}
              >
                {isUser ? (
                  user?.photoURL ? (
                    <img
                      src={user.photoURL}
                      alt="User"
                      className="w-8 h-8 rounded-full object-cover"
                    />
                  ) : (
                    <User className="w-4 h-4" />
                  )
                ) : (
                  <Sparkles className="w-4 h-4 text-blue-500" />
                )}
              </div>

              {/* Message Bubble & Metadata */}
              <div
                className={`flex flex-col max-w-[85%] sm:max-w-[78%] ${
                  isUser ? 'items-end' : 'items-start'
                }`}
              >
                <div
                  className={`rounded-2xl px-5 py-3.5 text-[15px] leading-relaxed transition-colors ${
                    isUser
                      ? 'bg-blue-600 text-white rounded-tr-sm shadow-sm'
                      : 'bg-gemini-surface dark:bg-gemini-darkSurface text-gray-900 dark:text-gray-100 rounded-tl-sm border border-black/5 dark:border-white/5'
                  }`}
                  dangerouslySetInnerHTML={{ __html: htmlContent }}
                />

                {/* Assistant Metadata & Controls */}
                {!isUser && (
                  <div className="flex items-center gap-2 mt-1.5 px-1 text-xs text-gray-400 dark:text-gray-500">
                    {msg.strategy_used && (
                      <span className="bg-black/5 dark:bg-white/5 px-2 py-0.5 rounded-md text-[11px] font-medium text-gray-500 dark:text-gray-400">
                        {msg.strategy_used}
                      </span>
                    )}
                    <button
                      onClick={() => copyToClipboard(msg.id, msg.content)}
                      className="p-1 rounded-md hover:bg-black/5 dark:hover:bg-white/10 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
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
        })
      )}

      {/* Generating pulse indicator */}
      {isGenerating && (
        <div className="flex gap-3.5 items-start animate-fade-in">
          <div className="w-8 h-8 rounded-full bg-gemini-surface dark:bg-gemini-darkSurface text-blue-500 flex items-center justify-center shrink-0 border border-black/5 dark:border-white/10">
            <Sparkles className="w-4 h-4 animate-spin text-blue-500" style={{ animationDuration: '3s' }} />
          </div>
          <div className="bg-gemini-surface dark:bg-gemini-darkSurface rounded-2xl rounded-tl-sm px-5 py-4 border border-black/5 dark:border-white/5 flex items-center gap-1.5">
            <div className="w-2 h-2 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: '0ms' }} />
            <div className="w-2 h-2 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: '150ms' }} />
            <div className="w-2 h-2 rounded-full bg-blue-500 animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
};
