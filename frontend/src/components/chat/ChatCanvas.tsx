import React, { useEffect, useRef } from 'react';
import DOMPurify from 'dompurify';
import { useChatStore } from '../../store';
import { Bot, User, Sparkles, Copy, Check } from 'lucide-react';

export const ChatCanvas: React.FC = () => {
  const { messages, isGenerating } = useChatStore();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [copiedId, setCopiedId] = React.useState<string | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isGenerating]);

  const copyToClipboard = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="flex-1 overflow-y-auto px-4 py-6 md:px-8 max-w-4xl mx-auto w-full space-y-6">
      {messages.length === 0 ? (
        <div className="h-full flex flex-col items-center justify-center text-center py-20 text-slate-400 dark:text-slate-500">
          <div className="w-16 h-16 rounded-2xl bg-blue-500/10 flex items-center justify-center text-blue-500 mb-4">
            <Sparkles className="w-8 h-8" />
          </div>
          <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-100 mb-2">Welcome to MindPal</h2>
          <p className="max-w-md text-sm">Your private companion for reflection, clarity, and grounded guidance. How can I support you today?</p>
        </div>
      ) : (
        messages.map((msg) => {
          const isUser = msg.role === 'user';
          const sanitizedContent = DOMPurify.sanitize(msg.content);

          return (
            <div
              key={msg.id}
              className={`flex gap-4 ${isUser ? 'flex-row-reverse' : 'flex-row'} items-start group`}
            >
              <div
                className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${
                  isUser
                    ? 'bg-blue-600 text-white'
                    : 'bg-slate-200 dark:bg-slate-800 text-slate-700 dark:text-slate-200'
                }`}
              >
                {isUser ? <User className="w-5 h-5" /> : <Bot className="w-5 h-5 text-blue-500" />}
              </div>

              <div
                className={`flex flex-col max-w-[85%] sm:max-w-[75%] ${
                  isUser ? 'items-end' : 'items-start'
                }`}
              >
                <div
                  className={`rounded-2xl px-5 py-3.5 text-sm leading-relaxed ${
                    isUser
                      ? 'bg-blue-600 text-white rounded-tr-none'
                      : 'bg-slate-100 dark:bg-slate-800/80 text-slate-900 dark:text-slate-100 rounded-tl-none border border-slate-200/60 dark:border-slate-700/50'
                  }`}
                  dangerouslySetInnerHTML={{ __html: sanitizedContent }}
                />

                {!isUser && (
                  <div className="flex items-center gap-2 mt-1.5 px-1 text-xs text-slate-400">
                    {msg.strategy_used && (
                      <span className="bg-slate-200/60 dark:bg-slate-800 px-2 py-0.5 rounded text-[11px] font-medium text-slate-500 dark:text-slate-400">
                        {msg.strategy_used}
                      </span>
                    )}
                    <button
                      onClick={() => copyToClipboard(msg.id, msg.content)}
                      className="p-1 rounded hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:outline-none"
                      title="Copy response"
                    >
                      {copiedId === msg.id ? <Check className="w-3.5 h-3.5 text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                )}
              </div>
            </div>
          );
        })
      )}

      {isGenerating && (
        <div className="flex gap-4 items-start">
          <div className="w-9 h-9 rounded-full bg-slate-200 dark:bg-slate-800 text-blue-500 flex items-center justify-center shrink-0">
            <Bot className="w-5 h-5 animate-pulse" />
          </div>
          <div className="bg-slate-100 dark:bg-slate-800/80 rounded-2xl rounded-tl-none px-5 py-3.5 border border-slate-200/60 dark:border-slate-700/50 flex items-center gap-1.5">
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
