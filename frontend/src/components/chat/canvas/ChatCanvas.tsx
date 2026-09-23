import React, { useEffect, useRef, useState, useCallback, useLayoutEffect } from 'react';
import { useChatStore, useAuthStore, useMemoryStore, useSessionStore, useChatHistoryStore } from '../../../store';
import { renderMarkdown } from '../../../utils/ui/markdown';
import { captureMemoryReceipt } from '../../../utils/memory/guestMemory';
import { useGreeting } from '../../../hooks/chat/useGreeting';
import { useOverlayPresence } from '../../../hooks/ui/useOverlayPresence';
import { ApiClient } from '../../../services/api';
import { cn } from '../../../utils/ui/cn';
import { LiveAnnouncer } from './LiveAnnouncer';
import { ChatCanvasEmptyState } from './ChatCanvasEmptyState';
import { ChevronDown } from 'lucide-react';
import { ChatCanvasMessage } from './ChatCanvasMessage';

interface ChatCanvasProps {
  onSelectMood?: (text: string) => void;
}

type FeedbackKind = 'thumbs_up' | 'thumbs_down';

const NEAR_BOTTOM_PX = 96;
/** Keep in sync with `.chat-jump-latest` opacity duration in style.css. */
const JUMP_EXIT_MS = 80;
const JUMP_LOCK_MS = 1500;

/**
 * Teach MindPal what helps. Signed-in only, and no message text leaves the
 * device: the server rewards or penalizes the strategy that produced the reply.
 */
async function sendReplyFeedback(kind: FeedbackKind, strategy: string | undefined) {
  if (!useSessionStore.getState().isAuthenticated) return;
  try {
    await ApiClient.rateReply(kind === 'thumbs_up' ? 'up' : 'down', strategy);
  } catch {
    // Feedback is best-effort; the local thumb state stays either way.
  }
}

function isNearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
}

export const ChatCanvas: React.FC<ChatCanvasProps> = ({ onSelectMood }) => {
  const { messages, isGenerating, updateMessage, setIsGenerating, setMessageMemoryReceipt, activeModel } = useChatStore();
  const editingUserId = useChatStore((state) => state.editingUserId);
  const activeSessionId = useChatHistoryStore((state) => state.activeSessionId);
  const { user, isLoading: authLoading } = useAuthStore();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const jumpingRef = useRef(false);
  const jumpTimerRef = useRef(0);
  const lastUserIdRef = useRef<string | null>(null);
  const knownMessageIdsRef = useRef<Set<string>>(new Set());
  const [enteringIds, setEnteringIds] = useState<Set<string>>(() => new Set());

  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const [thumbsState, setThumbsState] = useState<Record<string, FeedbackKind | null>>({});
  const [regeneratingId, setRegeneratingId] = useState<string | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const { greeting, isLoading: greetingLoading } = useGreeting(
    user ? { uid: user.uid, displayName: user.displayName } : null
  );
  const emptyLoading = authLoading || greetingLoading;
  const { mounted: jumpMounted, visible: jumpVisible } = useOverlayPresence(
    showJumpToLatest,
    JUMP_EXIT_MS
  );

  const clearJumpLock = useCallback(() => {
    jumpingRef.current = false;
    if (jumpTimerRef.current) {
      window.clearTimeout(jumpTimerRef.current);
      jumpTimerRef.current = 0;
    }
  }, []);

  const scrollCanvasToBottom = useCallback((smooth: boolean) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth ? 'smooth' : 'auto',
    });
  }, []);

  const syncJumpVisibility = useCallback((el: HTMLElement) => {
    const near = isNearBottom(el);
    stickToBottomRef.current = near;
    setShowJumpToLatest(!near && messages.length > 0);
  }, [messages.length]);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (jumpingRef.current) {
      if (isNearBottom(el)) {
        clearJumpLock();
        stickToBottomRef.current = true;
        setShowJumpToLatest(false);
      }
      return;
    }
    syncJumpVisibility(el);
  }, [clearJumpLock, syncJumpVisibility]);

  useEffect(() => {
    const lastUser = [...messages].reverse().find((message) => message.role === 'user');
    if (lastUser && lastUser.id !== lastUserIdRef.current) {
      lastUserIdRef.current = lastUser.id;
      stickToBottomRef.current = true;
      setShowJumpToLatest(false);
    }
  }, [messages]);

  useLayoutEffect(() => {
    const known = knownMessageIdsRef.current;
    const nextIds = messages.map((message) => message.id);
    const nextSet = new Set(nextIds);
    const fresh = nextIds.filter((id) => !known.has(id));
    const overlap = nextIds.some((id) => known.has(id));
    const bulkSwap = known.size > 0 && !overlap && nextIds.length > 0;
    const bulkOpen = known.size === 0 && nextIds.length > 1;

    if (bulkSwap || bulkOpen || fresh.length === 0) {
      setEnteringIds(new Set());
    } else {
      setEnteringIds(new Set(fresh));
    }
    knownMessageIdsRef.current = nextSet;
  }, [messages, activeSessionId]);

  // Stick to bottom without smooth scroll — smooth + enter animations fight and pop at the end.
  useLayoutEffect(() => {
    if (!stickToBottomRef.current || jumpingRef.current) return;
    scrollCanvasToBottom(false);
  }, [messages, isGenerating, scrollCanvasToBottom]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;

    const onUserInterrupt = () => {
      if (!jumpingRef.current) return;
      clearJumpLock();
      syncJumpVisibility(el);
    };
    const onScrollEnd = () => {
      if (!jumpingRef.current || !isNearBottom(el)) return;
      clearJumpLock();
      stickToBottomRef.current = true;
      setShowJumpToLatest(false);
    };

    el.addEventListener('wheel', onUserInterrupt, { passive: true });
    el.addEventListener('touchstart', onUserInterrupt, { passive: true });
    el.addEventListener('scrollend', onScrollEnd);

    // Fix 20: scrollend polyfill for Safari / older Chrome (Android) that don't
    // fire the scrollend event. Fall back to a 150ms debounce on 'scroll'.
    let scrollEndFallbackTimer = 0;
    const onScrollFallback = () => {
      window.clearTimeout(scrollEndFallbackTimer);
      scrollEndFallbackTimer = window.setTimeout(onScrollEnd, 150);
    };
    // Only install the fallback if scrollend is unsupported.
    const needsScrollEndPolyfill = !('onscrollend' in window);
    if (needsScrollEndPolyfill) {
      el.addEventListener('scroll', onScrollFallback, { passive: true });
    }

    return () => {
      el.removeEventListener('wheel', onUserInterrupt);
      el.removeEventListener('touchstart', onUserInterrupt);
      el.removeEventListener('scrollend', onScrollEnd);
      if (needsScrollEndPolyfill) {
        el.removeEventListener('scroll', onScrollFallback);
        window.clearTimeout(scrollEndFallbackTimer);
      }
      clearJumpLock();
    };
  }, [clearJumpLock, syncJumpVisibility]);

  // Fix 18: speechSynthesis.cancel() must be guarded for page-visibility — on iOS
  // calling it when the document is hidden (app backgrounded) throws NotAllowed and
  // corrupts the speech queue. We also cancel speech when the user backgrounds the
  // app so the audio doesn't keep playing after the screen is locked.
  useEffect(() => {
    const onVisibilityChange = () => {
      if (document.hidden && speakingId !== null) {
        window.speechSynthesis?.cancel();
        setSpeakingId(null);
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (!document.hidden) window.speechSynthesis?.cancel();
    };
  }, [speakingId]);

  const jumpToLatest = useCallback((event?: React.MouseEvent<HTMLButtonElement>) => {
    event?.currentTarget.blur();
    const el = scrollRef.current;
    if (!el) return;
    jumpingRef.current = true;
    stickToBottomRef.current = true;
    setShowJumpToLatest(false);
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    scrollCanvasToBottom(!reduce);
    if (jumpTimerRef.current) window.clearTimeout(jumpTimerRef.current);
    jumpTimerRef.current = window.setTimeout(() => {
      jumpingRef.current = false;
      jumpTimerRef.current = 0;
      if (isNearBottom(el)) {
        stickToBottomRef.current = true;
        setShowJumpToLatest(false);
      } else {
        syncJumpVisibility(el);
      }
    }, JUMP_LOCK_MS);
  }, [scrollCanvasToBottom, syncJumpVisibility]);

  const copyToClipboard = useCallback((id: string, text: string) => {
    navigator.clipboard.writeText(text).catch(() => {});
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  }, []);

  const toggleSpeak = useCallback((id: string, text: string) => {
    if (speakingId === id) {
      window.speechSynthesis.cancel();
      setSpeakingId(null);
      return;
    }
    window.speechSynthesis.cancel();
    const utt = new SpeechSynthesisUtterance(text);
    utt.onend = () => setSpeakingId(null);
    utt.onerror = () => setSpeakingId(null);
    window.speechSynthesis.speak(utt);
    setSpeakingId(id);
  }, [speakingId]);

  const handleThumb = useCallback(async (msgId: string, _content: string, kind: FeedbackKind) => {
    const alreadySet = thumbsState[msgId] === kind;
    setThumbsState((prev) => ({
      ...prev,
      [msgId]: prev[msgId] === kind ? null : kind,
    }));
    if (alreadySet) return; // un-toggling is local only
    const strategy = messages.find((m) => m.id === msgId)?.strategy_used;
    await sendReplyFeedback(kind, strategy);
  }, [messages, thumbsState]);

  const handleRegenerate = useCallback(async (targetMsgId?: string) => {
    if (isGenerating) return;

    const target = targetMsgId
      ? messages.find((m) => m.id === targetMsgId)
      : [...messages].reverse().find((m) => m.role === 'assistant');

    if (!target || target.role !== 'assistant') return;

    const targetIdx = messages.findIndex((m) => m.id === target.id);
    if (targetIdx === -1) return;

    let userMsg: (typeof messages)[0] | undefined;
    for (let i = targetIdx - 1; i >= 0; i--) {
      if (messages[i].role === 'user') {
        userMsg = messages[i];
        break;
      }
    }
    if (!userMsg) return;

    const userIdx = messages.findIndex((m) => m.id === userMsg.id);
    const history = messages.slice(Math.max(0, userIdx - 30), userIdx);

    setIsGenerating(true);
    setRegeneratingId(target.id);
    setMessageMemoryReceipt(target.id, null);

    updateMessage(target.id, '');

    const { ApiClient } = await import('../../../services/api');
    let current = '';

    const controller = new AbortController();
    useChatStore.getState().setAbortController(controller);

    await ApiClient.streamChat(
      userMsg.content,
      history,
      (chunk, strategy) => {
        current += chunk;
        updateMessage(target.id, current, strategy);
      },
      () => {
        setIsGenerating(false);
        setRegeneratingId(null);
        useChatStore.getState().setAbortController(null);
      },
      (err) => {
        console.error('Regeneration error:', err);
        updateMessage(target.id, err instanceof Error && err.message ? err.message : 'Unable to regenerate. Please try again.');
        setIsGenerating(false);
        setRegeneratingId(null);
        useChatStore.getState().setAbortController(null);
      },
      {
        model: activeModel,
        signal: controller.signal,
        onMemory: (receipt) => {
          const kept = captureMemoryReceipt(receipt, useSessionStore.getState().isAuthenticated);
          if (kept) setMessageMemoryReceipt(target.id, kept);
        },
      }
    );
  }, [messages, isGenerating, activeModel, updateMessage, setIsGenerating, setMessageMemoryReceipt]);

  const handleEditUser = useCallback((msgId: string) => {
    const state = useChatStore.getState();
    const idx = state.messages.findIndex((message) => message.id === msgId);
    if (idx === -1 || state.messages[idx].role !== 'user') return;
    if (state.isGenerating) state.stopGeneration();
    state.setEditingUserId(msgId);
  }, []);

  const handleCancelEdit = useCallback(() => {
    useChatStore.getState().setEditingUserId(null);
  }, []);

  const handleSaveEdit = useCallback(async (msgId: string, content: string) => {
    const trimmed = content.trim();
    if (!trimmed) return;

    const state = useChatStore.getState();
    const idx = state.messages.findIndex((message) => message.id === msgId);
    if (idx === -1 || state.messages[idx].role !== 'user') return;
    if (state.isGenerating) state.stopGeneration();

    const history = state.messages.slice(Math.max(0, idx - 30), idx);
    state.setMessages(
      state.messages.slice(0, idx + 1).map((message, index) =>
        index === idx ? { ...message, content: trimmed } : message
      )
    );
    state.setEditingUserId(null);

    const assistantMsgId = `msg_${Date.now()}`;
    state.addMessage({
      id: assistantMsgId,
      role: 'assistant',
      content: '',
      timestamp: new Date().toISOString(),
    });

    state.setIsGenerating(true);
    const controller = new AbortController();
    state.setAbortController(controller);
    let current = '';
    const { ApiClient } = await import('../../../services/api');

    await ApiClient.streamChat(
      trimmed,
      history,
      (chunk, strategy) => {
        current += chunk;
        useChatStore.getState().updateLastMessage(current, strategy);
      },
      () => {
        useChatStore.getState().setIsGenerating(false);
        useChatStore.getState().setAbortController(null);
      },
      (err) => {
        console.error('Edit resend error:', err);
        useChatStore.getState().updateLastMessage(
          err instanceof Error && err.message
            ? err.message
            : 'MindPal hit a connection issue while generating this response. Please retry this message.'
        );
        useChatStore.getState().setIsGenerating(false);
        useChatStore.getState().setAbortController(null);
      },
      {
        model: useChatStore.getState().activeModel,
        signal: controller.signal,
        onMemory: (receipt) => {
          const kept = captureMemoryReceipt(receipt, useSessionStore.getState().isAuthenticated);
          if (kept) useChatStore.getState().setMessageMemoryReceipt(assistantMsgId, kept);
        },
      }
    );
  }, []);

  return (
    <div className="relative flex h-full min-h-0 flex-1 flex-col">
      <div
        id="chat-canvas"
        ref={scrollRef}
        role="log"
        aria-live="polite"
        aria-relevant="additions text"
        aria-label="Conversation history"
        onScroll={handleScroll}
        className={cn(
          'flex min-h-0 flex-1 flex-col overflow-y-auto custom-scrollbar',
          messages.length === 0 && 'justify-end'
        )}
      >
        <LiveAnnouncer />

        {messages.length === 0 ? (
          <ChatCanvasEmptyState
            greeting={greeting}
            greetingLoading={emptyLoading}
            onSelectMood={onSelectMood}
          />
        ) : (
          <div
            key={activeSessionId || 'draft'}
            className="chat-thread-enter w-full max-w-3xl flex-1 px-4 py-8 sm:px-6 mx-auto"
          >
            <div className="space-y-8">
              {messages.map((msg, idx) => {
                const isUser = msg.role === 'user';
                const isLast = idx === messages.length - 1;
                const isStreamingThis = !isUser && ((isGenerating && isLast && !regeneratingId) || regeneratingId === msg.id);
                const htmlContent = renderMarkdown(msg.content);
                const thumbed = thumbsState[msg.id] ?? null;
                const editingIdx = editingUserId
                  ? messages.findIndex((message) => message.id === editingUserId)
                  : -1;
                const isEditing = Boolean(isUser && editingUserId === msg.id);

                return (
                  <ChatCanvasMessage
                    key={msg.id}
                    msg={msg}
                    isUser={isUser}
                    isStreamingThis={isStreamingThis}
                    isGenerating={isGenerating}
                    regeneratingId={regeneratingId}
                    copiedId={copiedId}
                    speakingId={speakingId}
                    thumbed={thumbed}
                    htmlContent={htmlContent}
                    animateEnter={enteringIds.has(msg.id)}
                    canEdit={isUser}
                    isEditing={isEditing}
                    isPendingReplace={editingIdx !== -1 && idx > editingIdx}
                    hasLaterReplies={isEditing && idx < messages.length - 1}
                    onCopy={copyToClipboard}
                    onEdit={handleEditUser}
                    onCancelEdit={handleCancelEdit}
                    onSaveEdit={handleSaveEdit}
                    onToggleSpeak={toggleSpeak}
                    onThumb={handleThumb}
                    onRegenerate={handleRegenerate}
                    onReviewMemory={() => {
                      const ids = msg.memoryReceipt?.saved.map((item) => item.id).filter(Boolean) ?? [];
                      useMemoryStore.getState().setIsOpen(true, 'atoms', ids);
                    }}
                    onDismissMemory={(id) => setMessageMemoryReceipt(id, null)}
                  />
                );
              })}
            </div>

            <div className="h-8" />
          </div>
        )}
      </div>

      {jumpMounted ? (
        <button
          type="button"
          onMouseDown={(event) => event.preventDefault()}
          onClick={jumpToLatest}
          aria-label="Jump to latest"
          className={cn('chat-jump-latest', !jumpVisible && 'is-leaving')}
        >
          Jump to latest
          <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
};
