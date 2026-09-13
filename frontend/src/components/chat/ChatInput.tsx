import React, { useState, useRef, useEffect, KeyboardEvent, forwardRef, useImperativeHandle } from 'react';
import { useChatStore, useVoiceStore, useStreakStore, useToastStore } from '../../store';
import { ApiClient } from '../../services/api';
import { telemetry } from '../../services/telemetry';
import { ArrowUp, AudioWaveform, ChevronDown, Check, Mic, Square, Sparkles, X } from 'lucide-react';

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

  const savedPreDictationTextRef = useRef<string>('');
  const currentDictationSpeechRef = useRef<string>('');

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

  useEffect(() => {
    return () => {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    };
  }, []);

  // Real-time voice dictation with OpenAI/Claude style controls (X cancel, waveform, ✓ confirm, ↑ send)
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

      // Save baseline text before dictation
      savedPreDictationTextRef.current = input;
      currentDictationSpeechRef.current = '';

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

        const speechChunk = (finalTranscript + ' ' + interimTranscript).trim();
        currentDictationSpeechRef.current = speechChunk;

        const base = savedPreDictationTextRef.current;
        const separator = base && !base.endsWith(' ') ? ' ' : '';
        setInput(base + (speechChunk ? separator + speechChunk : ''));
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

  const cancelDictation = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
    // Revert to pre-dictation snapshot!
    setInput(savedPreDictationTextRef.current);
    currentDictationSpeechRef.current = '';
    setIsDictating(false);
  };

  const confirmDictation = () => {
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
    setIsDictating(false);
  };

  const confirmAndSendDictation = () => {
    confirmDictation();
    setTimeout(() => {
      send(input);
    }, 50);
  };

  const send = async (textToSend: string) => {
    const trimmed = textToSend.trim();
    if (!trimmed || isGenerating) return;

    if (isDictating) {
      confirmDictation();
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

  return (
    <div className="w-full max-w-4xl mx-auto relative z-10 px-4 pb-safe pb-4">
      {/* Container with solid surface background matching top header items */}
      <div className="bg-gemini-surface dark:bg-gemini-darkSurface rounded-2xl sm:rounded-3xl p-2 sm:p-2.5 flex flex-col relative transition-all duration-200 w-full border border-black/[0.06] dark:border-white/[0.08] focus-within:border-[#4140FD]/60 dark:focus-within:border-[#6572F2]/60 shadow-sm">
        
        {/* Tier-1 Voice Dictation UI Bar (Matching Screenshots 3, 4, 5) */}
        {isDictating ? (
          <div className="flex items-center justify-between w-full h-11 px-2 animate-fade-in">
            {/* Left: Cancel Button (X) */}
            <button
              type="button"
              onClick={cancelDictation}
              className="w-8 h-8 rounded-full flex items-center justify-center bg-black/5 dark:bg-white/10 text-zinc-600 dark:text-zinc-300 hover:bg-black/10 dark:hover:bg-white/20 transition-colors"
              title="Cancel dictation & revert text"
              aria-label="Cancel dictation"
            >
              <X className="w-4 h-4" />
            </button>

            {/* Center: Live Dotted / Amplitude Soundwave Visualizer */}
            <div className="flex-1 flex items-center justify-center gap-1 mx-4 h-6 overflow-hidden">
              {[...Array(28)].map((_, i) => (
                <span
                  key={i}
                  className="w-0.5 bg-[#4140FD] dark:bg-[#6572F2] rounded-full animate-sound-wave"
                  style={{
                    animationDelay: `${(i % 5) * 120}ms`,
                    height: `${8 + (i % 4) * 4}px`,
                  }}
                />
              ))}
            </div>

            {/* Right: Confirm (✓) and Send (↑) */}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={confirmDictation}
                className="w-8 h-8 rounded-full flex items-center justify-center bg-black/5 dark:bg-white/10 text-zinc-700 dark:text-zinc-200 hover:bg-black/10 dark:hover:bg-white/20 transition-colors"
                title="Done dictating"
                aria-label="Confirm dictation"
              >
                <Check className="w-4 h-4 stroke-[2.5]" />
              </button>

              <button
                type="button"
                onClick={confirmAndSendDictation}
                className="w-8 h-8 rounded-full flex items-center justify-center bg-[#4140FD] hover:bg-[#5251fd] text-white transition-colors"
                title="Send message"
                aria-label="Send message"
              >
                <ArrowUp className="w-4 h-4" />
              </button>
            </div>
          </div>
        ) : (
          /* Standard Input Bar */
          <div className="flex items-end w-full">
            <textarea
              id="chat-input"
              ref={textareaRef}
              rows={1}
              dir="auto"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              className="flex-1 bg-transparent resize-none outline-none max-h-[200px] pl-3 pr-2 py-2 text-[15px] text-zinc-900 dark:text-zinc-100 placeholder-zinc-400 dark:placeholder-zinc-500 leading-6 min-h-[42px]"
              placeholder="Ask MindPal"
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
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl hover:bg-black/5 dark:hover:bg-white/10 text-[13px] font-medium text-zinc-700 dark:text-zinc-300 transition-colors focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none"
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
                      className="absolute bottom-full right-0 mb-2 w-64 bg-gemini-surface dark:bg-gemini-darkSurface border border-black/[0.08] dark:border-white/[0.08] rounded-2xl shadow-xl p-1.5 z-50 animate-fade-in"
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
                            ? 'bg-black/5 dark:bg-white/10'
                            : 'hover:bg-black/5 dark:hover:bg-white/5'
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
                            ? 'bg-black/5 dark:bg-white/10'
                            : 'hover:bg-black/5 dark:hover:bg-white/5'
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
                  onClick={startDictation}
                  className="w-8 h-8 flex items-center justify-center rounded-xl text-zinc-500 dark:text-zinc-400 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                  title="Start voice dictation"
                  aria-label="Start voice dictation"
                >
                  <Mic className="w-4 h-4" />
                </button>
              </div>

              {/* Dynamic Action Button */}
              <button
                id="action-btn"
                type="button"
                onClick={() => {
                  if (isGenerating) {
                    setIsGenerating(false);
                  } else if (hasText) {
                    send(input);
                  } else {
                    setIsVoiceActive(true);
                  }
                }}
                className={`w-9 h-9 sm:w-10 sm:h-10 flex-shrink-0 flex items-center justify-center rounded-full transition-all duration-200 focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none ${
                  isGenerating
                    ? 'bg-black/10 dark:bg-white/10 text-zinc-700 dark:text-zinc-200 hover:bg-black/20 dark:hover:bg-white/20'
                    : hasText
                    ? 'bg-[#4140FD] hover:bg-[#5251fd] text-white hover:scale-105 active:scale-95'
                    : 'bg-black/5 dark:bg-white/10 hover:bg-black/10 dark:hover:bg-white/20 text-zinc-700 dark:text-zinc-200'
                }`}
                aria-label={
                  isGenerating
                    ? "Stop generating"
                    : hasText
                    ? "Send message"
                    : "Open live voice conversation"
                }
                title={
                  isGenerating
                    ? "Stop generating"
                    : hasText
                    ? "Send"
                    : "Live Voice Mode"
                }
              >
                {isGenerating ? (
                  <Square className="w-3.5 h-3.5 fill-current" />
                ) : hasText ? (
                  <ArrowUp className="w-4 h-4 sm:w-5 sm:h-5" />
                ) : (
                  <AudioWaveform className="w-4 h-4 sm:w-5 sm:h-5 text-zinc-600 dark:text-zinc-300" />
                )}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Privacy Guarantee Note */}
      <div className="text-center mt-2.5 text-[12px] text-zinc-400 dark:text-zinc-500 select-none">
        MindPal guarantees privacy. Secure conversations & strict clinical safety protocols.
      </div>
    </div>
  );
});

ChatInput.displayName = 'ChatInput';
