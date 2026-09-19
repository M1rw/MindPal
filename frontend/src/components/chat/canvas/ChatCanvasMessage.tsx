import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../../../types';
import {
  Copy,
  Check,
  Volume2,
  ThumbsUp,
  ThumbsDown,
  RefreshCw,
  Pencil,
} from 'lucide-react';
import { cn } from '../../../utils/ui/cn';
import { ChatMemoryReceipt } from './ChatMemoryReceipt';
import { ChatVoiceReceipt } from './ChatVoiceReceipt';
import { ChatUserMessageEdit } from './ChatUserMessageEdit';

interface ChatCanvasMessageProps {
  msg: ChatMessage;
  isUser: boolean;
  isStreamingThis: boolean;
  isGenerating: boolean;
  regeneratingId: string | null;
  copiedId: string | null;
  speakingId: string | null;
  thumbed: 'thumbs_up' | 'thumbs_down' | null;
  htmlContent: string;
  animateEnter?: boolean;
  canEdit?: boolean;
  isEditing?: boolean;
  isPendingReplace?: boolean;
  hasLaterReplies?: boolean;
  onCopy: (id: string, text: string) => void;
  onEdit?: (id: string) => void;
  onCancelEdit?: () => void;
  onSaveEdit?: (id: string, content: string) => void;
  onToggleSpeak: (id: string, text: string) => void;
  onThumb: (msgId: string, content: string, kind: 'thumbs_up' | 'thumbs_down') => void;
  onRegenerate: (msgId: string) => void;
  onReviewMemory?: () => void;
  onDismissMemory?: (msgId: string) => void;
}

const actionBtnClass = (active?: boolean, activeClass?: string) =>
  cn(
    'msg-action-btn rounded-lg p-1.5 text-content-muted',
    'transition-colors duration-150 ease-out',
    'hover:bg-surface-subtle hover:text-content-primary',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary',
    active && activeClass
  );

const EDIT_MORPH_MS = 240;

function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function lockBoxSize(shell: HTMLElement, bubble: HTMLElement) {
  shell.style.width = `${shell.offsetWidth}px`;
  bubble.style.width = `${bubble.offsetWidth}px`;
  bubble.style.height = `${bubble.offsetHeight}px`;
}

function clearBoxSize(shell: HTMLElement, bubble: HTMLElement) {
  shell.style.width = '';
  bubble.style.width = '';
  bubble.style.height = '';
}

export const ChatCanvasMessage: React.FC<ChatCanvasMessageProps> = ({
  msg,
  isUser,
  isStreamingThis,
  isGenerating,
  regeneratingId,
  copiedId,
  speakingId,
  thumbed,
  htmlContent,
  animateEnter = false,
  canEdit = false,
  isEditing = false,
  isPendingReplace = false,
  hasLaterReplies = false,
  onCopy,
  onEdit,
  onCancelEdit,
  onSaveEdit,
  onToggleSpeak,
  onThumb,
  onRegenerate,
  onReviewMemory,
  onDismissMemory,
}) => {
  const isRetryableError = msg.content.includes('Please retry this message.');
  const copied = copiedId === msg.id;
  const speaking = speakingId === msg.id;
  const regenerating = regeneratingId === msg.id;
  const actionsActive = Boolean(copied || speaking || thumbed || regenerating || isRetryableError);
  const shellRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const morphingRef = useRef(false);
  const morphPlayedRef = useRef(false);
  const morphGenRef = useRef(0);
  const liveReceipt = msg.memoryReceipt && msg.memoryReceipt.saved.length > 0 ? msg.memoryReceipt : null;
  const receiptActive = Boolean(!isStreamingThis && liveReceipt && onReviewMemory && onDismissMemory);
  const [heldReceipt, setHeldReceipt] = useState(receiptActive ? liveReceipt : null);
  if (receiptActive && liveReceipt && heldReceipt !== liveReceipt) {
    setHeldReceipt(liveReceipt);
  }

  const lockBubbleForMorph = useCallback(() => {
    const shell = shellRef.current;
    const bubble = bubbleRef.current;
    if (!shell || !bubble || prefersReducedMotion()) return;
    lockBoxSize(shell, bubble);
    morphingRef.current = true;
    morphPlayedRef.current = false;
    morphGenRef.current += 1;
  }, []);

  useLayoutEffect(() => {
    const shell = shellRef.current;
    const bubble = bubbleRef.current;
    if (!shell || !bubble || !morphingRef.current || morphPlayedRef.current) return;
    if (prefersReducedMotion()) {
      clearBoxSize(shell, bubble);
      morphingRef.current = false;
      return;
    }

    const gen = morphGenRef.current;
    morphPlayedRef.current = true;
    bubble.classList.add('chat-user-bubble--morph');
    shell.classList.add('chat-user-shell--morph');
    void bubble.offsetWidth;

    if (isEditing) {
      shell.style.width = '100%';
      bubble.style.width = '100%';
      bubble.style.height = `${Math.max(bubble.scrollHeight, bubble.offsetHeight)}px`;
    } else {
      const fromW = bubble.offsetWidth;
      const fromH = bubble.offsetHeight;
      const fromShell = shell.offsetWidth;
      bubble.style.width = 'auto';
      bubble.style.height = 'auto';
      shell.style.width = 'fit-content';
      const toW = bubble.offsetWidth;
      const toH = bubble.offsetHeight;
      const toShell = shell.offsetWidth;
      bubble.style.width = `${fromW}px`;
      bubble.style.height = `${fromH}px`;
      shell.style.width = `${fromShell}px`;
      void bubble.offsetWidth;
      bubble.style.width = `${toW}px`;
      bubble.style.height = `${toH}px`;
      shell.style.width = `${toShell}px`;
    }

    let settled = false;
    const settle = () => {
      if (settled || gen !== morphGenRef.current) return;
      settled = true;
      bubble.classList.remove('chat-user-bubble--morph');
      shell.classList.remove('chat-user-shell--morph');
      clearBoxSize(shell, bubble);
      morphingRef.current = false;
      morphPlayedRef.current = false;
    };

    const onEnd = (event: TransitionEvent) => {
      if (event.target !== bubble) return;
      if (event.propertyName !== 'width' && event.propertyName !== 'height') return;
      settle();
    };

    bubble.addEventListener('transitionend', onEnd);
    const timeoutId = window.setTimeout(settle, EDIT_MORPH_MS + 40);
    return () => {
      bubble.removeEventListener('transitionend', onEnd);
      window.clearTimeout(timeoutId);
    };
  }, [isEditing]);

  if (msg.kind === 'voice_receipt') {
    return (
      <div className={cn('chat-turn chat-turn--call-ended', animateEnter && 'chat-msg-enter')}>
        <ChatVoiceReceipt
          htmlContent={htmlContent}
          usedS={msg.voice_used_s}
          copied={copied}
          onCopy={() => onCopy(msg.id, msg.content)}
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        'chat-turn flex',
        animateEnter && 'chat-msg-enter',
        isUser ? 'chat-turn--user justify-end' : 'chat-turn--assistant justify-start',
        isPendingReplace && 'chat-turn--pending-replace'
      )}
      aria-hidden={isPendingReplace || undefined}
      inert={isPendingReplace || undefined}
    >
      <div className={cn('flex flex-col', isUser ? cn('chat-user-shell w-fit max-w-[min(78%,36rem)] items-end', isEditing && 'chat-user-shell--editing w-full') : 'min-w-0 w-full items-start')} ref={isUser ? shellRef : undefined}>
        {isUser ? (
          <>
            <div
              ref={bubbleRef}
              dir="auto"
              className={cn(
                'chat-user-bubble w-fit max-w-full rounded-2xl border border-edge-subtle bg-surface-subtle px-3.5 py-2 text-start text-base leading-relaxed text-content-primary',
                isEditing ? 'chat-user-bubble--editing w-full' : 'whitespace-pre-wrap'
              )}
            >
              {isEditing && onCancelEdit && onSaveEdit ? (
                <ChatUserMessageEdit
                  messageId={msg.id}
                  initialValue={msg.content}
                  hasLaterReplies={hasLaterReplies}
                  onCancel={() => {
                    lockBubbleForMorph();
                    onCancelEdit();
                  }}
                  onSave={(id, content) => {
                    lockBubbleForMorph();
                    onSaveEdit(id, content);
                  }}
                />
              ) : (
                msg.content
              )}
            </div>
            {msg.content ? (
              <div
                className={cn(
                  'msg-actions flex flex-wrap items-center justify-end gap-0.5',
                  isEditing && 'msg-actions--away'
                )}
                role="group"
                aria-label="Message actions"
                data-active={actionsActive ? 'true' : undefined}
                inert={isEditing || undefined}
                aria-hidden={isEditing || undefined}
              >
                {canEdit && onEdit ? (
                  <button
                    type="button"
                    onClick={() => {
                      lockBubbleForMorph();
                      onEdit(msg.id);
                    }}
                    className={actionBtnClass()}
                    title="Edit and resend — later replies in this thread will be removed."
                    aria-label="Edit and resend this message"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => onCopy(msg.id, msg.content)}
                  className={actionBtnClass(copied, 'text-feedback-success')}
                  title="Copy"
                  aria-label="Copy message"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              </div>
            ) : null}
          </>
        ) : (
          <div className="w-full min-w-0">
            {isStreamingThis && msg.content === '' ? (
              <div className="py-1 text-content-muted" role="status">
                <span className="sr-only">Responding</span>
                <span className="chat-caret" aria-hidden="true" />
              </div>
            ) : (
              <div
                dir="auto"
                className={cn('chat-prose text-content-primary', isStreamingThis && 'chat-streaming')}
                dangerouslySetInnerHTML={{ __html: htmlContent }}
              />
            )}

            {!isStreamingThis && msg.content && (
              <div
                className="msg-actions flex flex-wrap items-center gap-0.5"
                role="group"
                aria-label="Response actions"
                data-active={actionsActive ? 'true' : undefined}
              >
                <button
                  type="button"
                  onClick={() => onCopy(msg.id, msg.content)}
                  className={actionBtnClass(copied, 'text-feedback-success')}
                  title="Copy"
                  aria-label="Copy response"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                </button>

                <button
                  type="button"
                  onClick={() => onToggleSpeak(msg.id, msg.content)}
                  className={actionBtnClass(speaking, 'bg-brand-subtle text-brand-primary')}
                  title={speaking ? 'Stop reading' : 'Read aloud'}
                  aria-label={speaking ? 'Stop reading aloud' : 'Read aloud'}
                >
                  <Volume2 className="h-3.5 w-3.5" />
                </button>

                <button
                  type="button"
                  onClick={() => onThumb(msg.id, msg.content, 'thumbs_up')}
                  className={actionBtnClass(thumbed === 'thumbs_up', 'bg-feedback-successSubtle text-feedback-success')}
                  title="Good response"
                  aria-label="Good response"
                >
                  <ThumbsUp className="h-3.5 w-3.5" />
                </button>

                <button
                  type="button"
                  onClick={() => onThumb(msg.id, msg.content, 'thumbs_down')}
                  className={actionBtnClass(thumbed === 'thumbs_down', 'bg-feedback-dangerSubtle text-feedback-danger')}
                  title="Bad response"
                  aria-label="Bad response"
                >
                  <ThumbsDown className="h-3.5 w-3.5" />
                </button>

                <button
                  type="button"
                  onClick={() => onRegenerate(msg.id)}
                  disabled={isGenerating}
                  className={cn(
                    actionBtnClass(),
                    isGenerating && 'cursor-not-allowed opacity-40'
                  )}
                  title={isRetryableError ? 'Retry response' : 'Regenerate'}
                  aria-label={isRetryableError ? 'Retry response' : 'Regenerate response'}
                >
                  <RefreshCw className={cn('h-3.5 w-3.5', regenerating && 'animate-spin')} />
                </button>
              </div>
            )}

            {heldReceipt && onReviewMemory && onDismissMemory ? (
              <ChatMemoryReceipt
                receipt={heldReceipt}
                active={receiptActive}
                onReview={onReviewMemory}
                onDismiss={() => {
                  onDismissMemory(msg.id);
                  setHeldReceipt(null);
                }}
              />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
};
