import React, { useState, useRef, useEffect, KeyboardEvent, forwardRef, useImperativeHandle } from 'react';
import { useChatStore, useVoiceStore, useStreakStore } from '../../store';
import { ApiClient } from '../../services/api';
import { ArrowUp, AudioWaveform, ChevronDown, Check, Info, Square } from 'lucide-react';

export interface ChatInputHandle {
  sendMessage: (text: string) => void;
  setInputText: (text: string) => void;
}

export const ChatInput = forwardRef<ChatInputHandle>((props, ref) => {
  const [input, setInput] = useState('');
  const [selectorOpen, setSelectorOpen] = useState(false);
  const selectorRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const {
    messages,
    addMessage,
    updateLastMessage,
    isGenerating,
    setIsGenerating,
    activeModel,
    setActiveModel,
    activeMode,
    setActiveMode,
  } = useChatStore();

  const { setIsActive: setIsVoiceActive } = useVoiceStore();
  const { recordActivity } = useStreakStore();

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (selectorRef.current && !selectorRef.current.contains(e.target as Node)) {
        setSelectorOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Auto-resize textarea
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

  const send = async (textToSend: string) => {
    const trimmed = textToSend.trim();
    if (!trimmed || isGenerating) return;

    // Record streak activity
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

    await ApiClient.streamChat(
      trimmed,
      messages.slice(-10),
      (chunk, strategy) => {
        currentContent += chunk;
        updateLastMessage(currentContent, strategy);
      },
      () => {
        setIsGenerating(false);
      },
      (err) => {
        console.error('Chat error:', err);
        updateLastMessage('An error occurred while connecting to MindPal. Please try again.');
        setIsGenerating(false);
      }
    );
  };

  useImperativeHandle(ref, () => ({
    sendMessage: (text: string) => send(text),
    setInputText: (text: string) => {
      setInput(text);
      textareaRef.current?.focus();
    },
  }));

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    send(input);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const modelLabel = activeModel === 'pro' ? 'Pro' : 'Standard';

  return (
    <div className="w-full max-w-4xl mx-auto relative z-10 px-4 pb-safe pb-4">
      {/* Pill Composer */}
      <div className="bg-gemini-surface dark:bg-gemini-darkSurface rounded-[32px] p-2 flex items-end relative transition-shadow w-full shadow-sm border border-black/[0.04] dark:border-white/[0.06]">
        <textarea
          id="chat-input"
          ref={textareaRef}
          rows={1}
          dir="auto"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          className="flex-1 bg-transparent resize-none outline-none max-h-[200px] pl-4 pr-2 py-2.5 text-[15px] text-gray-900 dark:text-gray-100 placeholder-gray-500 dark:placeholder-[#c4c7c5] leading-6 min-h-[44px]"
          placeholder="Ask MindPal"
          aria-label="Ask MindPal"
        />

        <div className="flex items-center gap-1 pr-1 h-11">
          {/* Unified Model + Mode Selector */}
          <div className="relative flex items-center h-full" ref={selectorRef}>
            <button
              id="unified-selector-btn"
              type="button"
              onClick={() => setSelectorOpen(!selectorOpen)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl hover:bg-black/5 dark:hover:bg-white/10 text-[13px] font-medium text-gray-700 dark:text-gray-300 transition-colors focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none"
              aria-haspopup="true"
              aria-expanded={selectorOpen}
              aria-label="Select model and listening style"
            >
              <span>{`${modelLabel} · ${activeMode}`}</span>
              <ChevronDown
                className={`w-3.5 h-3.5 text-gray-400 transition-transform duration-200 ${
                  selectorOpen ? 'rotate-180' : ''
                }`}
              />
            </button>

            {/* Dropdown Menu */}
            {selectorOpen && (
              <div
                id="unified-dropdown"
                className="absolute bottom-full right-0 mb-2 w-72 bg-white dark:bg-[#28283D] border border-[#E2E6F0] dark:border-[#35354A] rounded-2xl shadow-xl p-2 z-50 animate-fade-in"
                role="menu"
              >
                {/* Model Section */}
                <div className="text-[10px] font-bold text-gray-400 dark:text-gray-500 px-3 py-1.5 uppercase tracking-wider">
                  Model
                </div>

                <button
                  type="button"
                  onClick={() => {
                    setActiveModel('standard');
                    setSelectorOpen(false);
                  }}
                  className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl hover:bg-[#EFF3FB] dark:hover:bg-[#1E1E2E] transition-colors text-left"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
                        Standard
                      </span>
                    </div>
                    <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                      Warm peer support. Fast & safe.
                    </div>
                  </div>
                  {activeModel === 'standard' && (
                    <Check className="w-4 h-4 text-[#4140FD] flex-shrink-0" />
                  )}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setActiveModel('pro');
                    setSelectorOpen(false);
                  }}
                  className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl hover:bg-[#EFF3FB] dark:hover:bg-[#1E1E2E] transition-colors text-left"
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
                        Pro
                      </span>
                      <span className="bg-[#A39CF9]/20 text-[#4140FD] dark:bg-[#6572F2]/20 dark:text-[#A39CF9] text-[9px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wider">
                        Clinical
                      </span>
                    </div>
                    <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                      Deep analysis, diagnostic thinking.
                    </div>
                  </div>
                  {activeModel === 'pro' && (
                    <Check className="w-4 h-4 text-[#4140FD] flex-shrink-0" />
                  )}
                </button>

                <div className="h-px bg-gray-200 dark:bg-[#35354A] mx-2 my-1.5" />

                {/* Listening Mode Section */}
                <div className="text-[10px] font-bold text-gray-400 dark:text-gray-500 px-3 py-1.5 uppercase tracking-wider">
                  Listening Style
                </div>

                {(['Active Listen', 'Guided Coach', 'Cognitive Tools'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    onClick={() => {
                      setActiveMode(mode);
                      setSelectorOpen(false);
                    }}
                    className="w-full flex items-center justify-between px-3 py-2 rounded-xl hover:bg-[#EFF3FB] dark:hover:bg-[#1E1E2E] transition-colors text-left"
                  >
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-200">
                      {mode}
                    </span>
                    {activeMode === mode && (
                      <Check className="w-4 h-4 text-[#4140FD] flex-shrink-0" />
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Voice Overlay Button */}
          <button
            id="voice-btn"
            type="button"
            onClick={() => setIsVoiceActive(true)}
            className="w-10 h-10 flex-shrink-0 flex items-center justify-center rounded-full text-gray-700 dark:text-gray-200 hover:bg-black/5 dark:hover:bg-white/10 transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none"
            title="Start voice conversation"
            aria-label="Start voice conversation"
          >
            <AudioWaveform className="w-5 h-5 text-gray-600 dark:text-gray-300" />
          </button>

          {/* Send Button */}
          {input.trim() ? (
            <button
              id="send-btn"
              type="button"
              onClick={() => send(input)}
              disabled={isGenerating}
              className="w-10 h-10 flex-shrink-0 flex items-center justify-center rounded-full bg-[#4140FD] hover:bg-[#6572F2] text-white transition-all duration-200 hover:scale-105 active:scale-95 disabled:opacity-50 focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none shadow-md shadow-[#4140FD]/20"
              aria-label="Send message"
            >
              <ArrowUp className="w-5 h-5" />
            </button>
          ) : isGenerating ? (
            <button
              type="button"
              disabled
              className="w-10 h-10 flex-shrink-0 flex items-center justify-center rounded-full bg-black/10 dark:bg-white/10 text-gray-500"
              aria-label="Generating"
            >
              <Square className="w-3.5 h-3.5 fill-current animate-pulse" />
            </button>
          ) : null}
        </div>
      </div>

      {/* Privacy Guarantee Note */}
      <div className="text-center mt-2.5 text-[12px] text-gray-500 dark:text-[#c4c7c5] select-none">
        MindPal guarantees privacy. Secure conversations & strict clinical safety protocols.
      </div>
    </div>
  );
});

ChatInput.displayName = 'ChatInput';
