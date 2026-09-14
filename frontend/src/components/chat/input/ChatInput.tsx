import React, { useState, useRef, useEffect, KeyboardEvent, forwardRef, useImperativeHandle } from 'react';
import { useChatStore, useFlagsStore, useVoiceStore, useStreakStore, useToastStore } from '../../../store';
import { ApiClient } from '../../../services/api/index';
import { useChatInputDictation } from '../../../hooks/useChatInputDictation';
import { ChatInputActions } from './ChatInputActions';
import { ChatInputDictationMode } from './ChatInputDictationMode';

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

  const selectorRef = useRef<HTMLDivElement>(null);
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
  } = useChatStore();

  const { setIsActive: setIsVoiceActive } = useVoiceStore();
  const voiceEnabled = useFlagsStore((state) => Boolean(state.flags.voice_enabled));
  const { recordActivity } = useStreakStore();
  const { push: pushToast } = useToastStore();

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (selectorRef.current && !selectorRef.current.contains(e.target as Node)) {
        setSelectorOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const adjustHeight = () => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = 'auto';
      el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
    }
  };

  useEffect(() => {
    adjustHeight();
  }, [input]);

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

    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }

    setIsGenerating(true);

    const assistantMsgId = `msg_${Date.now()}`;
    addMessage({
      id: assistantMsgId,
      role: 'assistant' as const,
      content: '',
      timestamp: new Date().toISOString(),
    });

    let currentContent = '';

    try {
      await ApiClient.streamChat(
        trimmed,
        messages.slice(-10),
        (chunk, strategy) => {
          currentContent += chunk;
          updateLastMessage(currentContent, strategy);
        },
        () => {
          setIsGenerating(false);
          isSendingRef.current = false;
        },
        (err) => {
          console.error('Chat error:', err);
          updateLastMessage('MindPal hit a connection issue while generating this response. Please retry this message.');
          setIsGenerating(false);
          isSendingRef.current = false;
        },
        {
          model: activeModel,
        }
      );
    } catch {
      updateLastMessage('MindPal hit a connection issue while generating this response. Please retry this message.');
      setIsGenerating(false);
      isSendingRef.current = false;
    }
  }

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

  return (
    <div className="w-full max-w-4xl mx-auto relative z-10 px-4 pb-safe pb-4">
      <div className="bg-surface-subtle border border-edge-subtle rounded-[32px] p-2 flex flex-col relative transition-all duration-200 w-full shadow-card focus-within:shadow-glow-brand focus-within:border-brand-primary/40 focus-within:ring-2 focus-within:ring-brand-primary/20 specular-card">
        {isDictating ? (
          <ChatInputDictationMode
            input={input}
            textareaRef={textareaRef}
            handleKeyDown={handleKeyDown}
            audioVolume={audioVolume}
            hasText={hasText}
            onChangeInput={setInput}
            onCancelDictation={cancelDictation}
            onConfirmDictation={confirmDictation}
            onConfirmAndSendDictation={confirmAndSendDictation}
          />
        ) : (
          <div className="flex items-end w-full">
            <textarea
              id="chat-input"
              ref={textareaRef}
              rows={1}
              dir="auto"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1 bg-transparent resize-none outline-none max-h-[200px] pl-4 pr-2 py-2.5 text-md sm:text-base text-content-primary placeholder-content-muted leading-6 min-h-[44px]"
              placeholder="Ask MindPal"
              aria-label="Ask MindPal"
            />

            <ChatInputActions
              hasText={hasText}
              voiceEnabled={voiceEnabled}
              isGenerating={isGenerating}
              isPro={isPro}
              selectorOpen={selectorOpen}
              selectorRef={selectorRef}
              onToggleSelector={() => setSelectorOpen((current) => !current)}
              onSelectStandard={() => {
                setActiveModel('standard');
                setSelectorOpen(false);
              }}
              onSelectPro={() => {
                setActiveModel('pro');
                setSelectorOpen(false);
              }}
              onStartDictation={startDictation}
              onToggleGenerateOrVoice={() => {
                if (isGenerating) {
                  setIsGenerating(false);
                } else if (hasText) {
                  send(input);
                } else {
                  setIsVoiceActive(true);
                }
              }}
            />
          </div>
        )}
      </div>

      <div className="text-center mt-2.5 text-xs text-content-muted select-none">
        MindPal guarantees privacy. Secure conversations & strict clinical safety protocols.
      </div>
    </div>
  );
});

ChatInput.displayName = 'ChatInput';
