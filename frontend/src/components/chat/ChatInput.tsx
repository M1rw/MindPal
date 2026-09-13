import React, { useState, useRef, useEffect, KeyboardEvent, forwardRef, useImperativeHandle } from 'react';
import { useChatStore, useVoiceStore, useStreakStore, useToastStore } from '../../store';
import { ApiClient } from '../../services/api';
import { telemetry } from '../../services/telemetry';
import { ArrowUp, AudioWaveform, ChevronDown, Check, Mic, Square, Sparkles, X, Info } from 'lucide-react';

export interface ChatInputHandle {
  sendMessage: (text: string) => void;
  setInputText: (text: string) => void;
}

export const ChatInput = forwardRef<ChatInputHandle>((props, ref) => {
  const [input, setInput] = useState('');
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [showProInfo, setShowProInfo] = useState(false);
  const [isDictating, setIsDictating] = useState(false);
  const [audioVolume, setAudioVolume] = useState(0);

  const selectorRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recognitionRef = useRef<any>(null);
  const isDictatingRef = useRef<boolean>(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const animFrameRef = useRef<number | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);

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
    activeMode,
    setActiveMode,
  } = useChatStore();

  const { setIsActive: setIsVoiceActive } = useVoiceStore();
  const { recordActivity } = useStreakStore();
  const { push: pushToast } = useToastStore();

  // Close dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (selectorRef.current && !selectorRef.current.contains(e.target as Node)) {
        setSelectorOpen(false);
        setShowProInfo(false);
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

  const stopAudioAnalysis = () => {
    if (animFrameRef.current) {
      cancelAnimationFrame(animFrameRef.current);
      animFrameRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      try {
        audioContextRef.current.close();
      } catch {
        // AudioContext close error ignored
      }
      audioContextRef.current = null;
    }
    setAudioVolume(0);
  };

  const startAudioAnalysis = async () => {
    try {
      if (!navigator.mediaDevices?.getUserMedia) return;
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;

      const audioCtx = new AudioCtx();
      audioContextRef.current = audioCtx;

      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      analyser.smoothingTimeConstant = 0.6;
      analyserRef.current = analyser;

      const source = audioCtx.createMediaStreamSource(stream);
      source.connect(analyser);

      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);

      const updateVolume = () => {
        if (!isDictatingRef.current) return;
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < bufferLength; i++) {
          sum += dataArray[i];
        }
        const average = sum / bufferLength;
        const normalized = Math.min(100, Math.round((average / 128) * 100));
        setAudioVolume(normalized);
        animFrameRef.current = requestAnimationFrame(updateVolume);
      };

      animFrameRef.current = requestAnimationFrame(updateVolume);
    } catch (err) {
      console.warn('Audio analysis unavailable or permission denied:', err);
    }
  };

  useEffect(() => {
    return () => {
      isDictatingRef.current = false;
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
      stopAudioAnalysis();
    };
  }, []);

  // Real-time voice dictation with full audio reactivity & live transcription
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

      savedPreDictationTextRef.current = input;
      currentDictationSpeechRef.current = '';
      isDictatingRef.current = true;

      recognition.onstart = () => {
        setIsDictating(true);
        startAudioAnalysis();
      };

      recognition.onresult = (event: any) => {
        let finalTranscript = '';
        let interimTranscript = '';

        // Iterate over ALL results from 0 to results.length to retain previous sentences
        for (let i = 0; i < event.results.length; ++i) {
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
          isDictatingRef.current = false;
          setIsDictating(false);
          stopAudioAnalysis();
        }
      };

      recognition.onend = () => {
        // If user is still dictating (not cancelled or confirmed), restart for continuous dictation
        if (isDictatingRef.current) {
          try {
            recognition.start();
          } catch {
            isDictatingRef.current = false;
            setIsDictating(false);
            stopAudioAnalysis();
          }
        } else {
          setIsDictating(false);
          stopAudioAnalysis();
        }
      };

      recognitionRef.current = recognition;
      recognition.start();
    } catch (err) {
      console.error('Failed to start speech recognition:', err);
      isDictatingRef.current = false;
      setIsDictating(false);
      stopAudioAnalysis();
    }
  };

  const cancelDictation = () => {
    isDictatingRef.current = false;
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
    stopAudioAnalysis();
    setInput(savedPreDictationTextRef.current);
    currentDictationSpeechRef.current = '';
    setIsDictating(false);
  };

  const confirmDictation = () => {
    isDictatingRef.current = false;
    if (recognitionRef.current) {
      recognitionRef.current.stop();
    }
    stopAudioAnalysis();
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
      {/* Pill Container with smooth rounded-full geometry */}
      <div className="bg-[#f0f4f9] dark:bg-gemini-darkSurface rounded-[32px] p-2 flex flex-col relative transition-all duration-200 w-full border border-black/[0.04] dark:border-white/[0.06] shadow-sm">
        
        {/* Tier-1 Voice Dictation Top Bar with Real Reactive Audio Visualizer */}
        {isDictating && (
          <div className="flex items-center justify-between w-full pb-2 mb-1.5 border-b border-black/[0.06] dark:border-white/[0.06] animate-fade-in">
            {/* Left: Cancel Button (X) */}
            <button
              type="button"
              onClick={cancelDictation}
              className="px-2.5 py-1 rounded-lg flex items-center gap-1.5 bg-black/5 dark:bg-white/10 text-zinc-600 dark:text-zinc-300 hover:bg-black/10 dark:hover:bg-white/20 text-xs font-medium transition-colors"
              title="Cancel dictation & revert text"
              aria-label="Cancel dictation"
            >
              <X className="w-3.5 h-3.5" />
              <span>Cancel</span>
            </button>

            {/* Center: Real Voice-Reactive Soundwave */}
            <div className="flex-1 flex items-center justify-center gap-1 mx-3 h-6 overflow-hidden">
              <span className="text-[11px] font-medium text-[#4140FD] dark:text-[#6572F2] flex items-center gap-1.5 mr-2">
                <span className="w-2 h-2 rounded-full bg-[#4140FD] dark:bg-[#6572F2] animate-ping" />
                Listening
              </span>
              {[...Array(18)].map((_, i) => {
                const height = Math.max(
                  4,
                  Math.min(22, 4 + (audioVolume / 100) * 18 * (0.5 + 0.5 * Math.sin(i * 0.8)))
                );
                return (
                  <span
                    key={i}
                    className="w-1 bg-[#4140FD] dark:bg-[#6572F2] rounded-full transition-all duration-75"
                    style={{
                      height: `${height}px`,
                      opacity: 0.6 + (audioVolume / 250),
                    }}
                  />
                );
              })}
            </div>

            {/* Right: Done (✓) and Send (↑) */}
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={confirmDictation}
                className="px-2.5 py-1 rounded-lg flex items-center gap-1 bg-black/5 dark:bg-white/10 text-zinc-700 dark:text-zinc-200 hover:bg-black/10 dark:hover:bg-white/20 text-xs font-medium transition-colors"
                title="Done dictating"
                aria-label="Confirm dictation"
              >
                <Check className="w-3.5 h-3.5 stroke-[2.5]" />
                <span>Done</span>
              </button>

              <button
                type="button"
                onClick={confirmAndSendDictation}
                className="w-7 h-7 rounded-lg flex items-center justify-center bg-[#4140FD] hover:bg-[#5251fd] text-white transition-colors"
                title="Send message"
                aria-label="Send message"
              >
                <ArrowUp className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        )}

        {/* Input Bar — Always visible so the user sees live streaming words */}
        <div className="flex items-end w-full">
          <textarea
            id="chat-input"
            ref={textareaRef}
            rows={1}
            dir="auto"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            className="flex-1 bg-transparent resize-none outline-none max-h-[200px] pl-4 pr-2 py-2.5 text-[15px] text-zinc-900 dark:text-zinc-100 placeholder-zinc-500 dark:placeholder-zinc-400 leading-6 min-h-[44px]"
            placeholder={isDictating ? 'Speaking to MindPal...' : 'Ask MindPal'}
            aria-label="Ask MindPal"
          />

          {/* Actions Cluster */}
          <div className="flex items-center gap-1.5 pr-0.5 pb-0.5 self-end">
            {/* Collapsible Secondary Options: Model Selector & Dictation Trigger */}
            <div
              className={`flex items-center gap-1 transition-all duration-300 ease-out ${
                hasText && !isDictating
                  ? 'max-w-0 opacity-0 overflow-hidden pointer-events-none -translate-x-1'
                  : 'max-w-[320px] opacity-100 translate-x-0'
              }`}
            >
              {/* Minimalist 2-Choice Model Selector (Standard vs Pro) with PRO tag & info description */}
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
                  <span>{isPro ? 'Pro' : 'Standard'} · {activeMode}</span>
                  {isPro && (
                    <span className="bg-[#4140FD]/10 dark:bg-[#6572F2]/20 text-[#4140FD] dark:text-[#A39CF9] text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider">
                      PRO
                    </span>
                  )}
                  <ChevronDown
                    className={`w-3.5 h-3.5 text-zinc-400 transition-transform duration-200 ${
                      selectorOpen ? 'rotate-180' : ''
                    }`}
                  />
                </button>



                {/* Unified Model + Listening Style Dropdown */}
                {selectorOpen && (
                  <div
                    id="unified-dropdown"
                    className="absolute bottom-full right-0 mb-2 w-72 bg-white dark:bg-[#28283D] border border-[#E2E6F0] dark:border-[#35354A] rounded-2xl shadow-xl p-2 z-50 animate-fade-in"
                    role="menu"
                  >
                    {/* Model Section Header */}
                    <div className="text-[10px] font-bold text-zinc-400 dark:text-zinc-500 px-3 py-1.5 uppercase tracking-wider">
                      Model
                    </div>

                    {/* Standard Option */}
                    <div className="relative group/std">
                      <button
                        type="button"
                        onClick={() => {
                          setActiveModel('standard');
                          setSelectorOpen(false);
                        }}
                        className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl hover:bg-[#EFF3FB] dark:hover:bg-[#1E1E2E] transition-colors text-left"
                        role="menuitem"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Standard</span>
                            <button
                              type="button"
                              className="p-0.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 rounded-full transition-colors flex-shrink-0"
                              title="About Standard model"
                              aria-label="Standard model info"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Info className="w-3 h-3" />
                            </button>
                          </div>
                          <div className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                            Warm peer support. Fast & safe.
                          </div>
                        </div>
                        {activeModel === 'standard' && <Check className="w-4 h-4 text-[#4140FD] flex-shrink-0" />}
                      </button>
                      {/* Standard hover tooltip */}
                      <div className="hidden group-hover/std:block absolute left-full top-0 ml-2 w-56 p-2.5 rounded-xl bg-zinc-900 dark:bg-zinc-800 text-white text-[11px] leading-relaxed shadow-2xl border border-white/10 z-[60] pointer-events-none">
                        Fast, warm peer-support model. Safety-first with low latency. Best for everyday check-ins and emotional support.
                      </div>
                    </div>

                    {/* Pro Option */}
                    <div className="relative group/pro">
                      <button
                        type="button"
                        onClick={() => {
                          setActiveModel('pro');
                          setSelectorOpen(false);
                        }}
                        className="w-full flex items-center justify-between px-3 py-2.5 rounded-xl hover:bg-[#EFF3FB] dark:hover:bg-[#1E1E2E] transition-colors text-left"
                        role="menuitem"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">Pro</span>
                            <span className="bg-[#A39CF9]/20 text-[#4140FD] dark:bg-[#6572F2]/20 dark:text-[#A39CF9] text-[9px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wider">
                              Clinical
                            </span>
                            <span className="bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 text-[9px] px-1.5 py-0.5 rounded font-semibold uppercase tracking-wider">
                              2× Usage
                            </span>
                            <button
                              type="button"
                              className="p-0.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 rounded-full transition-colors flex-shrink-0"
                              title="About Pro model"
                              aria-label="Pro model info"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <Info className="w-3 h-3" />
                            </button>
                          </div>
                          <div className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                            Deep analysis, diagnostic thinking.
                          </div>
                        </div>
                        {activeModel === 'pro' && <Check className="w-4 h-4 text-[#4140FD] flex-shrink-0" />}
                      </button>
                      {/* Pro hover tooltip */}
                      <div className="hidden group-hover/pro:block absolute left-full top-0 ml-2 w-56 p-2.5 rounded-xl bg-zinc-900 dark:bg-zinc-800 text-white text-[11px] leading-relaxed shadow-2xl border border-white/10 z-[60] pointer-events-none">
                        <div className="font-semibold text-[#A39CF9] mb-1 text-[10px] uppercase tracking-wide">Pro · 2× Usage</div>
                        Uses 2× compute budget for in-depth clinical reasoning, longitudinal memory synthesis, and emotional nuance.
                      </div>
                    </div>

                  </div>
                )}
              </div>

              {/* Real-time Voice Dictation Trigger */}
              <button
                type="button"
                onClick={isDictating ? confirmDictation : startDictation}
                className={`w-8 h-8 flex items-center justify-center rounded-xl transition-colors ${
                  isDictating
                    ? 'bg-[#4140FD] text-white shadow-sm'
                    : 'text-zinc-500 dark:text-zinc-400 hover:bg-black/5 dark:hover:bg-white/10'
                }`}
                title={isDictating ? 'Stop dictating' : 'Start voice dictation'}
                aria-label="Voice dictation"
              >
                <Mic className="w-4 h-4" />
              </button>
            </div>

            {/* Dynamic Action Button — True circular geometry */}
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
              className={`w-9 h-9 sm:w-10 sm:h-10 min-w-[36px] min-h-[36px] sm:min-w-[40px] sm:min-h-[40px] aspect-square flex-shrink-0 flex items-center justify-center rounded-full transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-[#4140FD] focus-visible:outline-none ${
                isGenerating
                  ? 'bg-black/10 dark:bg-white/10 text-zinc-700 dark:text-zinc-200 hover:bg-black/20 dark:hover:bg-white/20'
                  : hasText
                  ? 'bg-[#1A1A2E] dark:bg-white text-white dark:text-[#1A1A2E] shadow-sm hover:bg-zinc-800 dark:hover:bg-zinc-100 active:scale-95'
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
      </div>

      {/* Privacy Guarantee Note */}
      <div className="text-center mt-2.5 text-[12px] text-zinc-400 dark:text-zinc-500 select-none">
        MindPal guarantees privacy. Secure conversations & strict clinical safety protocols.
      </div>
    </div>
  );
});

ChatInput.displayName = 'ChatInput';
