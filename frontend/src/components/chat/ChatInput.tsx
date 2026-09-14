import React, { useState, useRef, useEffect, KeyboardEvent, forwardRef, useImperativeHandle } from 'react';
import { useChatStore, useVoiceStore, useStreakStore, useToastStore } from '../../store';
import { ApiClient } from '../../services/api';
import { ArrowUp, AudioWaveform, ChevronDown, Check, Mic, Square, X } from 'lucide-react';

export interface ChatInputHandle {
  sendMessage: (text: string) => void;
  setInputText: (text: string) => void;
}

export const ChatInput = forwardRef<ChatInputHandle>((_props, ref) => {
  const [input, setInput] = useState('');
  const [selectorOpen, setSelectorOpen] = useState(false);
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
    let SpeechRecognition =
      (window as any).SpeechRecognition ||
      (window as any).webkitSpeechRecognition ||
      (window as any).__MOCK_SPEECH_RECOGNITION__;

    if (!SpeechRecognition) {
      if (typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('mockSpeech') === 'true') {
        SpeechRecognition = class {
          continuous = true;
          interimResults = true;
          lang = 'en-US';
          onstart: any = null;
          onresult: any = null;
          onerror: any = null;
          onend: any = null;
          start() {
            setTimeout(() => {
              if (this.onstart) this.onstart();
              setTimeout(() => {
                if (this.onresult) {
                  this.onresult({
                    results: [
                      [{ transcript: 'hello how are you', isFinal: true }]
                    ]
                  });
                }
              }, 120);
            }, 60);
          }
          stop() {
            if (this.onend) this.onend();
          }
        };
      } else {
        pushToast('Voice dictation is not supported in this browser. Try Chrome, Edge, or Safari.', 'warning');
        return;
      }
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
      <div className="bg-[#f0f4f9] dark:bg-gemini-darkSurface rounded-[32px] p-2 flex flex-col relative transition-all duration-200 w-full shadow-sm">
        
        {isDictating ? (
          /* ChatGPT-style Voice Dictation Mode */
          <div className="flex flex-col w-full px-2.5 py-1 sm:px-3 animate-fade-in">
            {/* Live streaming text with subtle opacity to indicate actively listening */}
            <textarea
              id="chat-input"
              ref={textareaRef}
              rows={1}
              dir="auto"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              className="w-full bg-transparent resize-none outline-none max-h-[160px] px-2 pt-1 pb-2 text-[15px] opacity-65 text-zinc-700 dark:text-zinc-300 placeholder-zinc-400 dark:placeholder-zinc-500 leading-relaxed min-h-[42px] transition-opacity"
              placeholder="Listening..."
              aria-label="Listening to your voice"
            />

            {/* Clean ChatGPT-Style Voice Bar */}
            <div className="flex items-center justify-between w-full pt-1 pb-1 px-0.5 gap-3">
              {/* Left: Circular Cancel Button (X) */}
              <button
                type="button"
                onClick={cancelDictation}
                className="voice-action-btn w-9 h-9 min-w-[36px] min-h-[36px] max-w-[36px] max-h-[36px] !min-h-[36px] aspect-square rounded-full flex items-center justify-center bg-black/5 dark:bg-white/10 text-zinc-600 dark:text-zinc-400 hover:bg-black/10 dark:hover:bg-white/20 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors active:scale-95 flex-shrink-0 p-0"
                title="Cancel dictation"
                aria-label="Cancel dictation"
              >
                <X className="w-4 h-4" />
              </button>

              {/* Center: Real Voice-Reactive Waveform */}
              <div className="flex-1 flex items-center justify-center gap-[3px] mx-2 h-8 overflow-hidden">
                {[...Array(28)].map((_, i) => {
                  const centerDist = Math.abs(i - 13.5) / 13.5;
                  const envelope = Math.max(0.2, 1 - centerDist * 0.7);
                  const isActive = audioVolume > 3;
                  const barHeight = isActive
                    ? Math.max(
                        3,
                        Math.min(
                          22,
                          3 + (audioVolume / 100) * 19 * envelope * (0.4 + 0.6 * Math.sin(i * 0.7))
                        )
                      )
                    : 3;
                  return (
                    <span
                      key={i}
                      className={`rounded-full transition-all duration-75 ${
                        isActive && barHeight > 4
                          ? 'w-[3px] bg-[#4140FD] dark:bg-white'
                          : 'w-[3px] h-[3px] bg-zinc-300 dark:bg-zinc-600'
                      }`}
                      style={{
                        height: `${barHeight}px`,
                      }}
                    />
                  );
                })}
              </div>

              {/* Right: Circular Stop (■) & Send (↑) Buttons */}
              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  type="button"
                  onClick={confirmDictation}
                  className="voice-action-btn w-9 h-9 min-w-[36px] min-h-[36px] max-w-[36px] max-h-[36px] !min-h-[36px] aspect-square rounded-full flex items-center justify-center bg-black/5 dark:bg-white/10 text-zinc-700 dark:text-zinc-200 hover:bg-black/10 dark:hover:bg-white/20 transition-colors active:scale-95 flex-shrink-0 p-0"
                  title="Done dictating"
                  aria-label="Done dictating"
                >
                  <Square className="w-3.5 h-3.5 fill-current" />
                </button>

                <button
                  type="button"
                  onClick={confirmAndSendDictation}
                  disabled={!hasText}
                  className="voice-action-btn w-9 h-9 min-w-[36px] min-h-[36px] max-w-[36px] max-h-[36px] !min-h-[36px] aspect-square rounded-full flex items-center justify-center bg-[#4140FD] hover:bg-[#3231d6] text-white transition-colors active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed shadow-sm flex-shrink-0 p-0"
                  title="Send message"
                  aria-label="Send message"
                >
                  <ArrowUp className="w-4 h-4 stroke-[2.5]" />
                </button>
              </div>
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
              className="flex-1 bg-transparent resize-none outline-none max-h-[200px] pl-4 pr-2 py-2.5 text-[15px] text-zinc-900 dark:text-zinc-100 placeholder-zinc-500 dark:placeholder-zinc-400 leading-6 min-h-[44px]"
              placeholder="Ask MindPal"
              aria-label="Ask MindPal"
            />

            {/* Actions Cluster */}
            <div className="flex items-center gap-1.5 pr-0.5 pb-0.5 self-end">
              {/* Collapsible Secondary Options: Model Selector & Dictation Trigger */}
              <div
                className={`flex items-center gap-1 transition-all duration-300 ease-out ${
                  hasText
                    ? 'max-w-0 opacity-0 overflow-hidden pointer-events-none -translate-x-1'
                    : 'max-w-[320px] opacity-100 translate-x-0'
                }`}
              >
                {/* Minimalist 2-Choice Model Selector (Standard vs Pro) with PRO tag */}
                <div className="relative flex items-center" ref={selectorRef}>
                  <button
                    type="button"
                    id="model-selector-btn"
                    onClick={() => setSelectorOpen(!selectorOpen)}
                    className="chat-compact-btn flex items-center gap-1.5 px-2.5 py-1 rounded-xl text-[13px] font-medium text-zinc-700 dark:text-zinc-300 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                  >
                    <span>{isPro ? 'Pro' : 'Standard'}</span>
                    {isPro && (
                      <span className="bg-[#4140FD]/10 dark:bg-[#6572F2]/20 text-[#4140FD] dark:text-[#A39CF9] text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider">
                        PRO
                      </span>
                    )}
                    <ChevronDown
                      className={`w-3.5 h-3.5 text-zinc-400 transition-transform ${
                        selectorOpen ? 'rotate-180' : ''
                      }`}
                    />
                  </button>

                  {/* Minimalist Model Dropdown */}
                  {selectorOpen && (
                    <div
                      id="unified-dropdown"
                      className="absolute bottom-full right-0 mb-2 w-72 bg-gemini-surface dark:bg-gemini-darkSurface border border-black/[0.08] dark:border-white/[0.08] rounded-xl shadow-xl p-1.5 z-50 animate-fade-in"
                      role="menu"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          setActiveModel('standard');
                          setSelectorOpen(false);
                        }}
                        className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-left transition-colors ${
                          !isPro
                            ? 'bg-black/5 dark:bg-white/10'
                            : 'hover:bg-black/5 dark:hover:bg-white/5'
                        }`}
                      >
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Standard</span>
                            <span className="text-[9px] font-semibold text-zinc-500 dark:text-zinc-400 bg-black/5 dark:bg-white/10 px-1 py-0.5 rounded">
                              1x
                            </span>
                          </div>
                          <div className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                            Warm peer support. Fast, safe & lightweight.
                          </div>
                        </div>
                        {!isPro && <Check className="w-4 h-4 text-[#4140FD] flex-shrink-0" />}
                      </button>

                      <button
                        type="button"
                        onClick={() => {
                          setActiveModel('pro');
                          setSelectorOpen(false);
                        }}
                        className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-left transition-colors mt-1 ${
                          isPro
                            ? 'bg-black/5 dark:bg-white/10'
                            : 'hover:bg-black/5 dark:hover:bg-white/5'
                        }`}
                      >
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Pro</span>
                            <span className="bg-[#4140FD]/10 dark:bg-[#6572F2]/20 text-[#4140FD] dark:text-[#A39CF9] text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-wider">
                              PRO · 2X
                            </span>
                          </div>
                          <div className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                            Clinical reasoning & deep analysis. Uses 2x compute.
                          </div>
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
                  className="chat-compact-btn w-8 h-8 flex items-center justify-center rounded-xl text-zinc-500 dark:text-zinc-400 hover:bg-black/5 dark:hover:bg-white/10 transition-colors"
                  title="Start voice dictation"
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
