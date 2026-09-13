import React, { useEffect, useRef } from 'react';
import DOMPurify from 'dompurify';
import { useChatStore } from '../../store';
import { Volume2, Copy, ThumbsUp, ThumbsDown, RotateCw, Check } from 'lucide-react';

export const ChatCanvas: React.FC = () => {
  const { messages } = useChatStore();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [copiedId, setCopiedId] = React.useState<string | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const copyToClipboard = (id: string, text: string) => {
    navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="flex-1 overflow-y-auto px-4 py-8 md:px-12 max-w-3xl mx-auto w-full space-y-8">
      {messages.map((msg) => {
        const isUser = msg.role === 'user';
        const sanitizedContent = DOMPurify.sanitize(msg.content);

        return (
          <div
            key={msg.id}
            className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} space-y-2`}
          >
            {isUser ? (
              <div className="bg-[#f0f4f9] dark:bg-[#1e1f20] text-[#1f1f1f] dark:text-[#e3e3e3] px-5 py-3 rounded-2xl max-w-[80%] text-sm leading-relaxed shadow-sm">
                {msg.content}
              </div>
            ) : (
              <div className="flex flex-col max-w-[90%] items-start space-y-2 text-slate-800 dark:text-slate-200">
                <div
                  className="text-sm leading-relaxed text-[#1f1f1f] dark:text-[#e3e3e3]"
                  dangerouslySetInnerHTML={{ __html: sanitizedContent }}
                />

                <div className="flex items-center gap-3 text-slate-400 dark:text-slate-500 pt-1">
                  <button
                    className="hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                    title="Read aloud"
                  >
                    <Volume2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => copyToClipboard(msg.id, msg.content)}
                    className="hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                    title="Copy response"
                  >
                    {copiedId === msg.id ? (
                      <Check className="w-3.5 h-3.5 text-green-500" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                  <button
                    className="hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                    title="Good response"
                  >
                    <ThumbsUp className="w-3.5 h-3.5" />
                  </button>
                  <button
                    className="hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                    title="Bad response"
                  >
                    <ThumbsDown className="w-3.5 h-3.5" />
                  </button>
                  <button
                    className="hover:text-slate-600 dark:hover:text-slate-300 transition-colors"
                    title="Regenerate"
                  >
                    <RotateCw className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
};
