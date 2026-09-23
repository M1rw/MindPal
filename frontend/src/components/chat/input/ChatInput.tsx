import React, { useState, useRef, useEffect, KeyboardEvent, forwardRef, useImperativeHandle } from 'react';
import { useChatStore, useFlagsStore, useSessionStore, useSettingsStore, useStreakStore, useToastStore, useVoiceStore } from '../../../store';
import { ApiClient } from '../../../services/api/index';
import { captureMemoryReceipt } from '../../../utils/memory/guestMemory';
import { useChatInputDictation } from '../../../hooks/chat/useChatInputDictation';
import { useOverlayPresence } from '../../../hooks/ui/useOverlayPresence';
import { Maximize2, Minimize2 } from 'lucide-react';
import { cn } from '../../../utils/ui/cn';
import { ChatInputActions } from './ChatInputActions';
import { ChatInputDictationMode } from './ChatInputDictationMode';
import { ComposerNotice } from './ComposerNotice';
import { stopHaptic, triggerHaptic } from '../../../utils/ui/haptics';

/** Keep in sync with `composerThinkOut` duration in style.css. */
const COMPOSER_THINK_EXIT_MS = 450;
/** Keep in sync with `.chat-composer__field` max-height in style.css. */
const COMPOSER_IDLE_MAX_PX = 200;
/** Keep in sync with `.chat-composer--expanded .chat-composer__field` max-height. */
const COMPOSER_EXPANDED_MAX_PX = 576;

function expandedFieldMaxPx() {
  // Fix 8: use visualViewport.height so the cap accounts for the open keyboard.
  // On mobile (< 640px) cap at 50% so the composer never fills the whole screen.
  const vh = window.visualViewport?.height ?? window.innerHeight;
  const pct = window.innerWidth < 640 ? 0.5 : 0.7;
  return Math.round(Math.min(vh * pct, COMPOSER_EXPANDED_MAX_PX));
}

export interface ChatInputHandle {
  sendMessage: (text: string) => void;
  setInputText: (text: string) => void;
}

export interface ChatInputProps {
  onBeforeSend?: () => void;
}

export const ChatInput = forwardRef<ChatInputHandle, ChatInputProps>((props, ref) => {
  const [input, setInput] = useState('');
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [fieldGrown, setFieldGrown] = useState(false);
  const [fieldOverflowing, setFieldOverflowing] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const expandedRef = useRef(false);
  expandedRef.current = expanded;

  const selectorRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isSendingRef = useRef(false);

  const {
    messages,
    addMessage,
    updateLastMessage,
    isGenerating,
    setIsGenerating,
    activeModel,
    setActiveModel,
    stopGeneration,
    composerDraft,
  } = useChatStore();

  const { recordActivity } = useStreakStore();
  const { push: pushToast } = useToastStore();
  const isAuthenticated = useSessionStore((state) => state.isAuthenticated);
  const soundEnabled = useSettingsStore((state) => state.settings.soundEnabled);
  const liveVoiceEnabled = useFlagsStore((state) => state.flags.voice_enabled);
  const setVoiceActive = useVoiceStore((state) => state.setIsActive);
  const editingUserId = useChatStore((state) => state.editingUserId);
  const isEditingThread = Boolean(editingUserId);

  const { mounted: thinkingMounted, visible: thinkingVisible } = useOverlayPresence(
    isGenerating,
    COMPOSER_THINK_EXIT_MS,
  );
  const [thinkFrom, setThinkFrom] = useState('0turn');
  const [thinkCycle, setThinkCycle] = useState(0);
  const thinkArmedRef = useRef(false);

  if (isGenerating && !thinkArmedRef.current) {
    thinkArmedRef.current = true;
    setThinkFrom(`${Math.random()}turn`);
    setThinkCycle((n) => n + 1);
  }
  if (!isGenerating) {
    thinkArmedRef.current = false;
  }

  useEffect(() => {
    if (!isGenerating || !soundEnabled) {
      stopHaptic();
      return;
    }

    const pulse = () => triggerHaptic(true, 'thinking');
    pulse();
    const intervalId = window.setInterval(pulse, 900);
    const stopOnHidden = () => {
      if (document.hidden) stopHaptic();
    };
    document.addEventListener('visibilitychange', stopOnHidden);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener('visibilitychange', stopOnHidden);
      stopHaptic();
    };
  }, [isGenerating, soundEnabled]);

  useEffect(() => {
    const handleClickOutside = (e: PointerEvent) => {
      // Fix 13: use pointerdown (not mousedown) so outside-tap dismisses the
      // mode selector on iOS/Android which may not fire synthetic mouse events.
      const target = e.target as Node | null;
      if (selectorRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest('.chat-mode-menu')) return;
      setSelectorOpen(false);
    };

    document.addEventListener('pointerdown', handleClickOutside);
    return () => document.removeEventListener('pointerdown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (isGenerating) setSelectorOpen(false);
  }, [isGenerating]);

  useEffect(() => {
    if (!isGenerating) {
      isSendingRef.current = false;
    }
  }, [isGenerating]);

  const adjustHeight = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const content = el.scrollHeight;
    const overflowing = content > COMPOSER_IDLE_MAX_PX + 1;
    let nextExpanded = expandedRef.current;
    if (nextExpanded && !overflowing) {
      nextExpanded = false;
      setExpanded(false);
    }
    const cap = nextExpanded ? expandedFieldMaxPx() : COMPOSER_IDLE_MAX_PX;
    el.style.height = `${Math.min(content, cap)}px`;
    const grown = el.offsetHeight > 52;
    setFieldGrown((current) => (current === grown ? current : grown));
    setFieldOverflowing((current) => (current === overflowing ? current : overflowing));
  };

  useEffect(() => {
    adjustHeight();
  }, [input, expanded]);

  useEffect(() => {
    window.addEventListener('resize', adjustHeight);
    return () => window.removeEventListener('resize', adjustHeight);
  }, []);

  useEffect(() => {
    if (!expanded || selectorOpen) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setExpanded(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded, selectorOpen]);

  useEffect(() => {
    if (composerDraft == null) return;
    setInput(composerDraft);
    useChatStore.getState().setComposerDraft(null);
    window.requestAnimationFrame(() => textareaRef.current?.focus());
  }, [composerDraft]);

  async function send(textToSend: string) {
    const trimmed = textToSend.trim();
    if (!trimmed || isGenerating || isSendingRef.current) return;

    isSendingRef.current = true;
    props.onBeforeSend?.();

    recordActivity();

    const userMessageId = `usr_${Date.now()}`;
    const userMsg = {
      id: userMessageId,
      role: 'user' as const,
      content: trimmed,
      timestamp: new Date().toISOString(),
    };

    addMessage(userMsg);
    setInput('');
    setExpanded(false);

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    const assistantMsgId = `msg_${Date.now()}`;
    addMessage({
      id: assistantMsgId,
      role: 'assistant' as const,
      content: '',
      timestamp: new Date().toISOString(),
    });

    const controller = new AbortController();
    useChatStore.getState().setAbortController(controller);
    setIsGenerating(true);

    let currentContent = '';

    try {
      await ApiClient.streamChat(
        trimmed,
        messages.slice(-30),
        (chunk, strategy) => {
          currentContent += chunk;
          updateLastMessage(currentContent, strategy);
        },
        () => {
          setIsGenerating(false);
          isSendingRef.current = false;
          useChatStore.getState().setAbortController(null);
        },
        (err) => {
          console.error('Chat error:', err);
          updateLastMessage(err.message || 'MindPal hit a connection issue while generating this response. Please retry this message.');
          setIsGenerating(false);
          isSendingRef.current = false;
          useChatStore.getState().setAbortController(null);
        },
        {
          model: activeModel,
          signal: controller.signal,
          onMemory: (receipt) => {
            const kept = captureMemoryReceipt(receipt, useSessionStore.getState().isAuthenticated);
            if (kept) useChatStore.getState().setMessageMemoryReceipt(assistantMsgId, kept);
          },
        }
      );
    } catch {
      updateLastMessage('MindPal hit a connection issue while generating this response. Please retry this message.');
      setIsGenerating(false);
      isSendingRef.current = false;
      useChatStore.getState().setAbortController(null);
    }
  }

  const handleStop = () => {
    const state = useChatStore.getState();
    const last = state.messages[state.messages.length - 1];
    stopGeneration();
    isSendingRef.current = false;
    if (last?.role === 'assistant' && last.content === '') {
      state.removeMessage(last.id);
    }
  };

  const {
    isDictating,
    audioVolume,
    startDictation,
    cancelDictation,
    confirmDictation,
    confirmAndSendDictation,
  } = useChatInputDictation({
    input,
    setInput,
    pushToast,
    onSend: send,
  });

  useEffect(() => {
    if (isDictating) setSelectorOpen(false);
  }, [isDictating]);

  useImperativeHandle(ref, () => ({
    sendMessage: (text: string) => send(text),
    setInputText: (text: string) => {
      setInput(text);
      textareaRef.current?.focus();
    },
  }));

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!isSendingRef.current && !isGenerating) {
      send(input);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!isSendingRef.current && !isGenerating) {
        handleSubmit();
      }
    }
  };

  const hasText = input.trim().length > 0;
  const isPro = activeModel === 'pro';
  const showExpand = fieldOverflowing && !isDictating && !isEditingThread;

  return (
    <div className="w-full max-w-3xl mx-auto relative z-10 px-4 pt-3 pb-safe pb-4">
      <div
        ref={composerRef}
        className={cn(
          'chat-composer bg-surface-subtle border border-edge-subtle p-2 flex flex-col relative w-full focus-within:border-brand-primary/30 focus-within:ring-1 focus-within:ring-brand-primary/15',
          isDictating && 'chat-composer--dictating',
          expanded && 'chat-composer--expanded',
          isEditingThread && 'chat-composer--editing',
          thinkingMounted && 'chat-composer--thinking',
          thinkingMounted && !thinkingVisible && 'chat-composer--thinking-out',
        )}
        aria-disabled={isEditingThread || undefined}
        inert={isEditingThread || undefined}
        data-think-cycle={thinkCycle % 2 === 0 ? 'a' : 'b'}
        style={{ '--composer-think-from': thinkFrom } as React.CSSProperties}
      >
        <div className={cn('chat-composer__row', fieldGrown && 'chat-composer__row--grown')}>
          <div className="chat-composer__body">
            <div className="chat-composer__field-wrap">
              <textarea
                id="chat-input"
                ref={textareaRef}
                rows={1}
                dir="auto"
                spellCheck={false}
                // Fix 14: disable autocorrect & autocapitalize so iOS doesn't
                // mangle technical terms, code snippets, or mid-word completions.
                // autoCapitalize="sentences" still lets the first word of a
                // sentence get capitalised naturally.
                autoCorrect="off"
                autoCapitalize="sentences"
                autoComplete="off"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                className="chat-composer__field custom-scrollbar bg-transparent resize-none outline-none pl-4 pr-2 py-2.5 text-md sm:text-base text-content-primary placeholder-content-muted leading-6 min-h-[44px]"
                placeholder={isDictating ? 'Listening...' : 'Ask MindPal'}
                aria-label={isDictating ? 'Listening to your voice' : 'Ask MindPal'}
              />
            </div>
          </div>

          <div
            className={cn(
              'chat-composer__idle-actions',
              showExpand && 'chat-composer__idle-actions--expand',
            )}
            aria-hidden={isDictating}
            inert={isDictating}
          >
            {showExpand ? (
              <button
                type="button"
                className="chat-composer__expand chat-compact-btn w-8 h-8 flex items-center justify-center rounded-xl text-content-secondary hover:text-content-primary hover:bg-surface-elevated transition-[transform,background-color,color] duration-200 ease-out hover:scale-110 active:scale-95 motion-reduce:transition-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-primary"
                onClick={() => {
                  setExpanded((current) => !current);
                  window.requestAnimationFrame(() => textareaRef.current?.focus());
                }}
                title={expanded ? 'Collapse' : 'Expand'}
                aria-label={expanded ? 'Collapse composer' : 'Expand composer'}
                aria-pressed={expanded}
              >
                {expanded ? <Minimize2 className="h-4 w-4" aria-hidden="true" /> : <Maximize2 className="h-4 w-4" aria-hidden="true" />}
              </button>
            ) : null}
            <ChatInputActions
              hasText={hasText}
              isGenerating={isGenerating}
              isPro={isPro}
              selectorOpen={selectorOpen}
              selectorRef={selectorRef}
              onToggleSelector={() => {
                if (!isGenerating) setSelectorOpen((current) => !current);
              }}
              onCloseSelector={() => setSelectorOpen(false)}
              onSelectStandard={() => {
                if (isGenerating) return;
                setActiveModel('standard');
                setSelectorOpen(false);
              }}
              onSelectPro={() => {
                if (isGenerating) return;
                setActiveModel('pro');
                setSelectorOpen(false);
              }}
              onStartDictation={startDictation}
              liveVoiceEnabled={liveVoiceEnabled}
              onStartLiveVoice={() => setVoiceActive(true)}
              onStop={handleStop}
              onSend={() => send(input)}
            />
          </div>
        </div>

        <div className="chat-composer__dictate" aria-hidden={!isDictating} inert={!isDictating}>
          <div className="chat-composer__dictate-inner">
            <ChatInputDictationMode
              audioVolume={audioVolume}
              hasText={hasText}
              onCancelDictation={cancelDictation}
              onConfirmDictation={confirmDictation}
              onConfirmAndSendDictation={confirmAndSendDictation}
            />
          </div>
        </div>
      </div>

      <ComposerNotice
        hasMessages={messages.length > 0}
        hasText={hasText}
        isDictating={isDictating}
        isGenerating={isGenerating}
        isEditing={isEditingThread}
        isAuthenticated={isAuthenticated}
      />
    </div>
  );
});

ChatInput.displayName = 'ChatInput';
