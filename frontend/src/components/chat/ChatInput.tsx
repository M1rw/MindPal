import React, { useState, useRef, useEffect, KeyboardEvent, forwardRef, useImperativeHandle } from 'react';
import { useChatStore, useVoiceStore, useStreakStore, useToastStore } from '../../store';
import { ApiClient } from '../../services/api';
import { telemetry } from '../../services/telemetry';
import { ArrowUp, AudioWaveform, ChevronDown, Check, Mic, MicOff, Square, Sparkles } from 'lucide-react';

export interface ChatInputHandle {
  sendMessage: (text: string) => void;
  setInputText: (text: string) => void;
}

export const ChatInput = forwardRef<ChatInputHandle>((props, ref) => {
  const [input, setInput] = useState('');
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [isDictating, setIsDictating] = useState(false);

  const selectorRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<any>(null);
  const baseDictationTextRef = useRef<string>('');

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
  const { recordActivity } = useStreakStore();
  const { push: pushToast } = useToastStore();

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

  // Cleanup speech recognition on unmount
  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    };
  }, []);

  // Real-time voice dictation handler
  const startDictation = () => {
    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) {
      pushToast('Voice dictation is not supported in this browser. Try Chrome, Edge, or Safari.', 'warning');
      return;
    }

    try {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.lang = 'en-US';

      baseDictationTextRef.current = input;

      recognition.onstart = () => {
        setIsDictating(true);
      };

      recognition.onresult = (event: any) => {
        let interimTranscript = '';
        let finalTranscript = '';

        for (let i = event.resultIndex; i < event.results.length; ++i) {
          if (event.results[i].isFinal) {
            finalTranscript += event.results[i][0].transcript;
          } else {
            interimTranscript += event.results[i][0].transcript;
          }
        }

        const combinedTranscript = (finalTranscript + ' ' + interimTranscript).trim();
        const base = baseDictationTextRef.current;
        const separator = base && !base.endsWith(' ') ? ' ' : '';
        setInput(base + (combinedTranscript ? separator + combinedTranscript : ''));
      };

      recognition.onerror = (event: any) => {
        console.warn('Speech recognition error:', event.error);
        if (event.error === 'not-allowed') {
          pushToast('Microphone access denied. Please allow microphone permissions.', 'error');
        }
        setIsDictating(false);
      };

      recognition.onend = () => {
        setIsDictating(false);
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch (err) {
      console.error('Failed to start speech recognition:', err);
      setIsDictating(false);
    }
  };

  const stopDictation = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
    setIsDictating(false);
  };

  const toggleDictation = () => {
    if (isDictating) {
      stopDictation();
    } else {
      startDictation();
    }
  };

  const send = async (textToSend: string) => {
    const trimmed = textToSend.trim();
    if (!trimmed || isGenerating) return;

    if (isDictating) {
      stopDictation();
    }

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
    const telemetrySnapshot = telemetry.getSnapshot();

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
      },
      {
        model: activeModel,
        telemetry: telemetrySnapshot,
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

  const hasText = input.trim().length > 0;
  const isPro = activeModel === 'pro';

  const handleActionClick = () => {
    if (isGenerating) {
      // In production, cancellation signal can be attached; resets generating state
      setIsGenerating(false);
    } else if (hasText) {
      send(input);
    } else if (isDictating) {
      stopDictation();
    } else {
      // Voice mode trigger
      setIsVoiceActive(true);
    }
  };

  return (
    <div className="w-full max-w-4xl mx-auto relative z-10 px-4 pb-safe pb-4">
      {/* Pill Composer Container */}
      <div className="bg-white dark:bg-[#18181B] rounded-2xl sm:rounded-3xl p-2 sm:p-2.5 flex items-end relative transition-all duration-200 w-full border border-black/[0.08] dark:border-white/[0.08] focus-within:border-[#4140FD]/60 dark:focus-within:border-[#6572F2]/60 shadow-sm">
        
        {/* Real-time Voice Dictation Waveform Visualizer */}
        {isDictating && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500/10 dark:bg-red-500/15 text-red-600 dark:text-red-400 rounded-xl border border-red-500/20 animate-fade-in mr-2 self-center flex-shrink-0">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            <div className="flex items-center gap-0.5 h-4">
              <span className="w-0.5 bg-red-500 rounded-full animate-sound-wave" style={{ animationDelay: '0ms' }} />
              <span className="w-0.5 bg-red-500 rounded-full animate-sound-wave" style={{ animationDelay: '200ms' }} />
              <span className="w-0.5 bg-red-500 rounded-full animate-sound-wave" style={{ animationDelay: '400ms' }} />
              <span className="w-0.5 bg-red-500 rounded-full animate-sound-wave" style={{ animationDelay: '100ms' }} />
            </div>
            <span className="text-xs font-medium pl-0.5 select-none hidden sm:inline">Listening...</span>
          </div>
        )}

        {/* Text Input Area */}
        <textarea
          id="chat-input"
          ref={textareaRef}
          rows={1}
          dir="auto"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          className="flex-1 bg-transparent resize-none outline-none max-h-[200px] pl-3 pr-2 py-2 text-[15px] text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 leading-6 min-h-[42px]"
          placeholder={isDictating ? "Listening... Speak naturally" : "Ask MindPal"}
          aria-label="Ask MindPal"
        />

        {/* Actions Cluster */}
        <div className="flex items-center gap-1.5 pr-0.5 h-10 self-end">
          
          {/* Collapsible Secondary Options: Model Selector & Dictation Trigger */}
          <div
            className={`flex items-center gap-1 transition-all duration-300 ease-out ${
              hasText
                ? 'max-w-0 opacity-0 overflow-hidden pointer-events-none -translate-x-1'
                : 'max-w-[280px] opacity-100 translate-x-0'
            }`}
          >
            {/* Minimalist 2-Choice Model Selector (Standard vs Pro) */}
            <div className="relative flex items-center" ref={selectorRef}>
              <button
                id="unified-selector-btn"
                type="button"
                onClick={() => setSelectorOpen(!selectorOpen)}
                className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl hover:bg-zinc-100 dark:hover:bg-zinc-800 text-[13px] font-medium text-zinc-700 dark:text-zinc-300 transition-colors focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none"
                aria-haspopup="true"
                aria-expanded={selectorOpen}
                aria-label="Select model: Standard or Pro"
              >
                <span>{isPro ? 'Pro' : 'Standard'}</span>
                {isPro && (
                  <span className="bg-[#4140FD]/10 dark:bg-[#6572F2]/20 text-[#4140FD] dark:text-[#A39CF9] text-[9px] px-1 py-0.5 rounded font-semibold uppercase">
                    Depth
                  </span>
                )}
                <ChevronDown
                  className={`w-3.5 h-3.5 text-zinc-400 transition-transform duration-200 ${
                    selectorOpen ? 'rotate-180' : ''
                  }`}
                />
              </button>

              {/* Minimalist Model Dropdown */}
              {selectorOpen && (
                <div
                  id="unified-dropdown"
                  className="absolute bottom-full right-0 mb-2 w-64 bg-white dark:bg-[#18181B] border border-black/[0.08] dark:border-white/[0.08] rounded-2xl shadow-xl p-1.5 z-50 animate-fade-in"
                  role="menu"
                >
                  <button
                    type="button"
                    onClick={() => {
                      setActiveModel('standard');
                      setSelectorOpen(false);
                    }}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-left transition-colors ${
                      !isPro
                        ? 'bg-zinc-100 dark:bg-zinc-800'
                        : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60'
                    }`}
                  >
                    <div>
                      <div className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Standard</div>
                      <div className="text-[11px] text-zinc-500 dark:text-zinc-400">Warm peer support. Fast & safe.</div>
                    </div>
                    {!isPro && <Check className="w-4 h-4 text-[#4140FD] flex-shrink-0" />}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setActiveModel('pro');
                      setSelectorOpen(false);
                    }}
                    className={`w-full flex items-center justify-between px-3 py-2 rounded-xl text-left transition-colors mt-1 ${
                      isPro
                        ? 'bg-zinc-100 dark:bg-zinc-800'
                        : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/60'
                    }`}
                  >
                    <div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Pro</span>
                        <Sparkles className="w-3 h-3 text-[#4140FD]" />
                      </div>
                      <div className="text-[11px] text-zinc-500 dark:text-zinc-400">Clinical reasoning & deep analysis.</div>
                    </div>
                    {isPro && <Check className="w-4 h-4 text-[#4140FD] flex-shrink-0" />}
                  </button>
                </div>
              )}
            </div>

            {/* Real-time Voice Dictation Trigger */}
            <button
              type="button"
              onClick={toggleDictation}
              className={`w-8 h-8 flex items-center justify-center rounded-xl transition-colors ${
                isDictating
                  ? 'bg-red-500/10 dark:bg-red-500/20 text-red-600 dark:text-red-400'
                  : 'text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800'
              }`}
              title={isDictating ? "Stop voice dictation" : "Start voice dictation"}
              aria-label={isDictating ? "Stop voice dictation" : "Start voice dictation"}
            >
              {isDictating ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
            </button>
          </div>

          {/* Dynamic Circular Action Button (Morphs between Voice, Send, and Stop) */}
          <button
            id="action-btn"
            type="button"
            onClick={handleActionClick}
            className={`w-9 h-9 sm:w-10 sm:h-10 flex-shrink-0 flex items-center justify-center rounded-full transition-all duration-200 focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none ${
              isGenerating
                ? 'bg-zinc-200 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-200 hover:bg-zinc-300 dark:hover:bg-zinc-700'
                : hasText
                ? 'bg-[#4140FD] hover:bg-[#5251fd] text-white hover:scale-105 active:scale-95'
                : isDictating
                ? 'bg-red-500 hover:bg-red-600 text-white animate-pulse'
                : 'bg-zinc-100 dark:bg-zinc-800 hover:bg-zinc-200 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-200'
            }`}
            aria-label={
              isGenerating
                ? "Stop generating"
                : hasText
                ? "Send message"
                : isDictating
                ? "Stop voice dictation"
                : "Open live voice conversation"
            }
            title={
              isGenerating
                ? "Stop generating"
                : hasText
                ? "Send"
                : isDictating
                ? "Stop dictation"
                : "Live Voice Mode"
            }
          >
            {isGenerating ? (
              <Square className="w-3.5 h-3.5 fill-current" />
            ) : hasText ? (
              <ArrowUp className="w-4 h-4 sm:w-5 sm:h-5" />
            ) : isDictating ? (
              <Square className="w-3.5 h-3.5 fill-current" />
            ) : (
              <AudioWaveform className="w-4 h-4 sm:w-5 sm:h-5 text-zinc-600 dark:text-zinc-300" />
            )}
          </button>
        </div>
      </div>

      {/* Privacy Guarantee Note */}
      <div className="text-center mt-2.5 text-[12px] text-zinc-400 dark:text-zinc-500 select-none">
        MindPal guarantees privacy. Secure conversations & strict clinical safety protocols.
      </div>
    </div>
  );
});

ChatInput.displayName = 'ChatInput';
