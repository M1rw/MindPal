import React from 'react';
import type { ChatMessage } from '../../../types';
import {
  Copy,
  Check,
  Volume2,
  ThumbsUp,
  ThumbsDown,
  RefreshCw,
} from 'lucide-react';

interface ChatCanvasMessageProps {
  msg: ChatMessage;
  index: number;
  isUser: boolean;
  isStreamingThis: boolean;
  isGenerating: boolean;
  regeneratingId: string | null;
  copiedId: string | null;
  speakingId: string | null;
  thumbed: 'thumbs_up' | 'thumbs_down' | null;
  htmlContent: string;
  onCopy: (id: string, text: string) => void;
  onToggleSpeak: (id: string, text: string) => void;
  onThumb: (msgId: string, content: string, kind: 'thumbs_up' | 'thumbs_down') => void;
  onRegenerate: (msgId: string) => void;
}

export const ChatCanvasMessage: React.FC<ChatCanvasMessageProps> = ({
  msg,
  index,
  isUser,
  isStreamingThis,
  isGenerating,
  regeneratingId,
  copiedId,
  speakingId,
  thumbed,
  htmlContent,
  onCopy,
  onToggleSpeak,
  onThumb,
  onRegenerate,
}) => {
  const delay = `${Math.min(index * 15, 80)}ms`;
  const isRetryableError = msg.content.includes('Please retry this message.');

  return (
    <div
      className={`flex ${isUser ? 'justify-end' : 'justify-start'} animate-msg-in`}
      style={{ animationDelay: delay }}
    >
      <div className={`flex flex-col ${isUser ? 'items-end max-w-[78%]' : 'items-start w-full'}`}>
        {isUser ? (
          <div className="px-4 py-2.5 rounded-[20px] bg-surface-subtle text-content-primary text-base leading-relaxed border border-edge-subtle/60 shadow-sm">
            {msg.content}
          </div>
        ) : (
          <div className="w-full">
            {isStreamingThis && msg.content === '' ? (
              <div className="flex items-center gap-2 py-1.5 text-content-muted animate-fade-in select-none">
                <div className="flex items-end gap-[2px] h-[15px] pb-[1px]" aria-hidden="true">
                  <span
                    className="w-[2px] h-[6px] bg-content-muted rounded-full animate-pulse"
                    style={{ animationDuration: '1.2s', animationDelay: '0ms' }}
                  />
                  <span
                    className="w-[2px] h-[14px] bg-content-muted rounded-full animate-pulse"
                    style={{ animationDuration: '1.2s', animationDelay: '200ms' }}
                  />
                  <span
                    className="w-[2px] h-[9px] bg-content-muted rounded-full animate-pulse"
                    style={{ animationDuration: '1.2s', animationDelay: '400ms' }}
                  />
                </div>
                <span className="text-sm font-medium text-content-secondary">Thinking</span>
                <span className="flex items-center gap-[2.5px] ml-0.5" aria-hidden="true">
                  <span
                    className="w-[3px] h-[3px] rounded-full bg-content-muted animate-pulse"
                    style={{ animationDuration: '1.4s', animationDelay: '0ms' }}
                  />
                  <span
                    className="w-[3px] h-[3px] rounded-full bg-content-muted animate-pulse"
                    style={{ animationDuration: '1.4s', animationDelay: '250ms' }}
                  />
                  <span
                    className="w-[3px] h-[3px] rounded-full bg-content-muted animate-pulse"
                    style={{ animationDuration: '1.4s', animationDelay: '500ms' }}
                  />
                </span>
              </div>
            ) : (
              <div
                className={[
                  'text-base leading-relaxed text-content-primary',
                  'prose prose-sm dark:prose-invert max-w-none',
                  'prose-p:my-1.5 prose-headings:mb-2 prose-headings:mt-4 prose-li:my-0.5',
                  isStreamingThis ? 'chat-streaming' : '',
                ].join(' ')}
                dangerouslySetInnerHTML={{ __html: htmlContent }}
              />
            )}

            {!isStreamingThis && msg.content && (
              <div className="flex items-center gap-0.5 mt-2.5">
                <button
                  onClick={() => onCopy(msg.id, msg.content)}
                  className="msg-action-btn p-1.5 rounded-lg text-content-muted hover:text-content-primary hover:bg-surface-subtle transition-colors"
                  title="Copy"
                  aria-label="Copy response"
                >
                  {copiedId === msg.id ? (
                    <Check className="w-4 h-4 text-emerald-500" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </button>

                <button
                  onClick={() => onToggleSpeak(msg.id, msg.content)}
                  className={`msg-action-btn p-1.5 rounded-lg transition-colors ${
                    speakingId === msg.id
                      ? 'text-brand-primary bg-brand-subtle'
                      : 'text-content-muted hover:text-content-primary hover:bg-surface-subtle'
                  }`}
                  title={speakingId === msg.id ? 'Stop reading' : 'Read aloud'}
                  aria-label="Read aloud"
                >
                  <Volume2 className="w-4 h-4" />
                </button>

                <button
                  onClick={() => onThumb(msg.id, msg.content, 'thumbs_up')}
                  className={`msg-action-btn p-1.5 rounded-lg transition-colors ${
                    thumbed === 'thumbs_up'
                      ? 'text-emerald-500 bg-emerald-500/10'
                      : 'text-content-muted hover:text-emerald-500 hover:bg-surface-subtle'
                  }`}
                  title="Good response"
                  aria-label="Good response"
                >
                  <ThumbsUp className="w-4 h-4" />
                </button>

                <button
                  onClick={() => onThumb(msg.id, msg.content, 'thumbs_down')}
                  className={`msg-action-btn p-1.5 rounded-lg transition-colors ${
                    thumbed === 'thumbs_down'
                      ? 'text-rose-500 bg-rose-500/10'
                      : 'text-content-muted hover:text-rose-500 hover:bg-surface-subtle'
                  }`}
                  title="Bad response"
                  aria-label="Bad response"
                >
                  <ThumbsDown className="w-4 h-4" />
                </button>

                <button
                  onClick={() => onRegenerate(msg.id)}
                  disabled={isGenerating}
                  className={`msg-action-btn p-1.5 rounded-lg text-content-muted hover:text-brand-primary hover:bg-surface-subtle transition-colors ${
                    isGenerating ? 'opacity-40 cursor-not-allowed' : ''
                  }`}
                  title={isRetryableError ? 'Retry response' : 'Regenerate'}
                  aria-label={isRetryableError ? 'Retry response' : 'Regenerate response'}
                >
                  <RefreshCw className={`w-4 h-4 ${regeneratingId === msg.id ? 'animate-spin' : ''}`} />
                </button>

                {isRetryableError && (
                  <button
                    type="button"
                    onClick={() => onRegenerate(msg.id)}
                    disabled={isGenerating}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-brand-primary/30 bg-brand-subtle px-2.5 py-1.5 text-xs font-medium text-brand-primary transition-colors hover:border-brand-primary/50 hover:bg-brand-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <RefreshCw className={`w-3.5 h-3.5 ${regeneratingId === msg.id ? 'animate-spin' : ''}`} />
                    Retry
                  </button>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
